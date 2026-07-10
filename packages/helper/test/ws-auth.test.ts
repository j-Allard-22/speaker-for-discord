/**
 * Integration tests for the localhost transport. Each names the vulnerability it closes.
 * A real HelperServer is bound on an ephemeral port and driven by raw `ws` clients.
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CLIENTS,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  loadOrCreateSessionKey,
  sessionNonce,
  sessionProof,
  type HelperToPluginMessage,
} from "@dsd/shared";
import { WebSocket, WebSocketServer } from "ws";
import { HelperLogger } from "../src/logger";
import { HelperServer } from "../src/ws-server";

const KEY = loadOrCreateSessionKey(mkdtempSync(join(tmpdir(), "dsd-wsauth-")));
const WRONG_KEY = loadOrCreateSessionKey(mkdtempSync(join(tmpdir(), "dsd-wsauth-bad-")));

function quietLogger(): HelperLogger {
  return new HelperLogger({
    dir: mkdtempSync(join(tmpdir(), "dsd-wsauth-log-")),
    mirrorToConsole: false,
    minLevel: "error",
  });
}

/** The Discord state that must NEVER reach an unauthenticated peer. */
const SECRET_SNAPSHOT: HelperToPluginMessage[] = [
  { type: "status", discord: "subscribed" },
  {
    type: "channel",
    channelId: "c1",
    guildId: "g1",
    channelName: "Secret Ops",
    members: [{ userId: "42", displayName: "Alice", avatarUrl: "https://cdn.discordapp.com/x.png" }],
  },
  { type: "speaker", speaker: null, speakingCount: 0 },
];

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const servers: HelperServer[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const w of sockets.splice(0)) w.terminate();
});

async function startServer(key: Buffer = KEY): Promise<number> {
  const port = await freePort();
  const server = new HelperServer({
    port,
    helperVersion: "1.0.0",
    buildId: "h-test",
    logger: quietLogger(),
    sessionKey: key,
    snapshot: () => SECRET_SNAPSHOT,
  });
  servers.push(server);
  await server.start();
  return port;
}

/** Records every frame the peer sends us. */
function connect(port: number, opts?: { origin?: string }): { ws: WebSocket; frames: any[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts?.origin ? { origin: opts.origin } : {});
  sockets.push(ws);
  const frames: any[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  ws.on("error", () => undefined); // client-side noise; assertions use readyState/frames
  return { ws, frames };
}

const waitFor = <T>(fn: () => T) => vi.waitFor(fn, { timeout: 3000, interval: 10 });

describe("S1 regression: no Discord state before the client authenticates", () => {
  it("a peer WITHOUT the session key never receives the roster", async () => {
    const port = await startServer();
    const { ws, frames } = connect(port);
    const clientNonce = sessionNonce();

    await waitFor(() => expect(frames[0]?.type).toBe("hello"));
    // hello must disclose nothing — not even the helper pid.
    expect(frames[0]).toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverNonce: expect.any(String),
    });
    expect(frames[0].pid).toBeUndefined();
    expect(frames[0].buildId).toBeUndefined();

    ws.send(JSON.stringify({ type: "clientChallenge", clientNonce }));
    await waitFor(() => expect(frames[1]?.type).toBe("serverAuth"));

    // Forge a proof with the WRONG key — this is the attacker.
    ws.send(
      JSON.stringify({
        type: "clientAuth",
        clientProof: sessionProof(WRONG_KEY, "C", frames[0].serverNonce, clientNonce),
      }),
    );

    await waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    const types = frames.map((f) => f.type);
    expect(types).toEqual(["hello", "serverAuth"]); // never welcome/status/channel/speaker
    expect(JSON.stringify(frames)).not.toContain("Secret Ops");
    expect(JSON.stringify(frames)).not.toContain("Alice");
  });

  it("a peer that stays silent is terminated by the handshake timeout", async () => {
    const port = await startServer();
    const { ws, frames } = connect(port);
    await waitFor(() => expect(frames[0]?.type).toBe("hello"));
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED), { timeout: 5000, interval: 50 });
    expect(frames.map((f) => f.type)).toEqual(["hello"]);
  });

  it("an app message sent before auth is refused (narrow handshake parser)", async () => {
    const port = await startServer();
    const { ws, frames } = connect(port);
    await waitFor(() => expect(frames[0]?.type).toBe("hello"));
    ws.send(JSON.stringify({ type: "getState" }));
    await waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(frames.map((f) => f.type)).toEqual(["hello"]);
  });

  it("the happy path yields welcome + the full snapshot", async () => {
    const port = await startServer();
    const { ws, frames } = connect(port);
    const clientNonce = sessionNonce();

    await waitFor(() => expect(frames[0]?.type).toBe("hello"));
    ws.send(JSON.stringify({ type: "clientChallenge", clientNonce }));
    await waitFor(() => expect(frames[1]?.type).toBe("serverAuth"));

    // The client verifies the SERVER's proof first (see S3 test), then proves itself.
    ws.send(
      JSON.stringify({
        type: "clientAuth",
        clientProof: sessionProof(KEY, "C", frames[0].serverNonce, clientNonce),
      }),
    );
    await waitFor(() => expect(frames.map((f) => f.type)).toContain("speaker"));
    expect(frames.map((f) => f.type)).toEqual([
      "hello",
      "serverAuth",
      "welcome",
      "status",
      "channel",
      "speaker",
    ]);
    expect(frames[2]).toMatchObject({ helperVersion: "1.0.0", buildId: "h-test", pid: process.pid });
  });
});

describe("S3 regression: the server proves possession first", () => {
  it("serverProof is unforgeable without the key and bound to the client's nonce", async () => {
    const port = await startServer();
    const { ws, frames } = connect(port);
    const clientNonce = sessionNonce();
    await waitFor(() => expect(frames[0]?.type).toBe("hello"));
    ws.send(JSON.stringify({ type: "clientChallenge", clientNonce }));
    await waitFor(() => expect(frames[1]?.type).toBe("serverAuth"));

    const sn = frames[0].serverNonce;
    const presented = frames[1].serverProof;
    // A real helper's proof verifies...
    expect(presented).toBe(sessionProof(KEY, "S", sn, clientNonce));
    // ...but it is NOT the client proof (domain separation kills the reflection attack)...
    expect(presented).not.toBe(sessionProof(KEY, "C", sn, clientNonce));
    // ...and it is bound to THIS clientNonce (kills replay of a captured proof).
    expect(presented).not.toBe(sessionProof(KEY, "S", sn, sessionNonce()));
  });

  it("a squatter with the wrong key cannot produce a serverProof the plugin accepts", async () => {
    const port = await startServer(WRONG_KEY); // "helper" holding the wrong key
    const { ws, frames } = connect(port);
    const clientNonce = sessionNonce();
    await waitFor(() => expect(frames[0]?.type).toBe("hello"));
    ws.send(JSON.stringify({ type: "clientChallenge", clientNonce }));
    await waitFor(() => expect(frames[1]?.type).toBe("serverAuth"));
    // The real plugin would verify against KEY and refuse — proof does not match.
    expect(frames[1].serverProof).not.toBe(sessionProof(KEY, "S", frames[0].serverNonce, clientNonce));
  });
});

describe("S4 regression: getState is unicast, not broadcast", () => {
  it("only the requester receives the echoed snapshot", async () => {
    const port = await startServer();
    const server = servers[0]!;
    server.on("message", (msg, reply) => {
      if (msg.type === "getState") reply({ type: "status", discord: "no_channel" });
    });

    const authenticate = async (c: { ws: WebSocket; frames: any[] }) => {
      const cn = sessionNonce();
      await waitFor(() => expect(c.frames[0]?.type).toBe("hello"));
      c.ws.send(JSON.stringify({ type: "clientChallenge", clientNonce: cn }));
      await waitFor(() => expect(c.frames[1]?.type).toBe("serverAuth"));
      c.ws.send(
        JSON.stringify({
          type: "clientAuth",
          clientProof: sessionProof(KEY, "C", c.frames[0].serverNonce, cn),
        }),
      );
      await waitFor(() => expect(c.frames.map((f) => f.type)).toContain("speaker"));
    };

    const a = connect(port);
    const b = connect(port);
    await authenticate(a);
    await authenticate(b);
    const bBefore = b.frames.length;

    a.ws.send(JSON.stringify({ type: "getState" }));
    await waitFor(() => expect(a.frames.filter((f) => f.discord === "no_channel")).toHaveLength(1));
    // B must not have been fanned out to.
    expect(b.frames.length).toBe(bBefore);
  });
});

describe("S5 regression: DoS bounds", () => {
  it("rejects an upgrade carrying an Origin header (browsers always send one)", async () => {
    const port = await startServer();
    const { ws } = connect(port, { origin: "https://evil.example" });
    const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(err.message).toMatch(/40[13]|unexpected server response/i);
  });

  it("closes a socket that sends a frame larger than maxPayload — WITHOUT crashing the helper", async () => {
    // An oversized frame makes ws emit "error" on the server socket. With no per-socket
    // error listener Node escalates that to uncaughtException and main.ts exits(1) —
    // i.e. any local peer could kill the helper with one frame. Assert the server lives.
    const port = await startServer();
    const server = servers[0]!;
    const uncaught = vi.fn();
    process.once("uncaughtException", uncaught);

    const { ws, frames } = connect(port);
    await waitFor(() => expect(frames[0]?.type).toBe("hello"));
    ws.send(JSON.stringify({ type: "clientChallenge", clientNonce: "x".repeat(MAX_PAYLOAD_BYTES + 10) }));
    await waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));

    expect(uncaught).not.toHaveBeenCalled();
    process.off("uncaughtException", uncaught);

    // The server is still healthy: a fresh client can still handshake.
    const survivor = connect(port);
    await waitFor(() => expect(survivor.frames[0]?.type).toBe("hello"));
    expect(server.clientCount).toBe(0);
  });

  it("refuses connections beyond the client cap", async () => {
    const port = await startServer();
    const closed: number[] = [];
    for (let i = 0; i <= MAX_CLIENTS; i++) {
      const { ws } = connect(port);
      ws.on("close", (code) => closed.push(code));
    }
    await waitFor(() => expect(closed).toContain(1013)); // "try again later"
  });

  it("an oversized frame on an OVER-CAP socket does not crash the helper", async () => {
    // Regression: the cap branch returned before the per-socket "error" listener was
    // attached, so a >maxPayload frame on the refused socket escaped to uncaughtException.
    const port = await startServer();
    const server = servers[0]!;
    const uncaught = vi.fn();
    process.once("uncaughtException", uncaught);

    const conns = [];
    for (let i = 0; i <= MAX_CLIENTS; i++) conns.push(connect(port));
    const overCap = conns[conns.length - 1]!;
    // Blast the refused socket with an oversized frame during its CLOSING window.
    for (let i = 0; i < 5; i++) {
      try {
        overCap.ws.send("x".repeat(MAX_PAYLOAD_BYTES + 10));
      } catch {
        /* socket already closing */
      }
    }
    await new Promise((r) => setTimeout(r, 300));

    expect(uncaught).not.toHaveBeenCalled();
    process.off("uncaughtException", uncaught);

    // Server still healthy: free the slots, then a fresh client can handshake.
    for (const c of conns) c.ws.terminate();
    await waitFor(() => expect(server.clientCount).toBe(0));
    const survivor = connect(port);
    await waitFor(() => expect(survivor.frames[0]?.type).toBe("hello"));
  });
});

describe("clientCount excludes unauthenticated peers (orphan-watch cannot be pinned open)", () => {
  it("a silent connector does not count as a client", async () => {
    const port = await startServer();
    const server = servers[0]!;
    connect(port);
    await new Promise((r) => setTimeout(r, 100));
    expect(server.clientCount).toBe(0);
  });
});

describe("a real WebSocketServer without our guards would leak (control)", () => {
  it("demonstrates the pre-fix behavior for contrast", async () => {
    // Sanity anchor: a bare ws server happily talks to anyone, which is exactly what
    // the old helper did. If this ever fails, the test harness itself is broken.
    const port = await freePort();
    const wss = new WebSocketServer({ host: "127.0.0.1", port });
    wss.on("connection", (ws) => ws.send(JSON.stringify(SECRET_SNAPSHOT[1])));
    const { frames } = connect(port);
    await waitFor(() => expect(frames[0]?.channelName).toBe("Secret Ops"));
    wss.close();
  });
});
