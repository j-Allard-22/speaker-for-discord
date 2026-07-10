/**
 * S3 regression: a process squatting the helper's port must never receive the user's
 * Discord credentials. The plugin verifies the SERVER's proof before it sends anything.
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  loadOrCreateSessionKey,
  sessionNonce,
  sessionProof,
  type WelcomeMessage,
} from "@dsd/shared";
import { WebSocketServer, type WebSocket } from "ws";
import { HelperClient, SpeakerStore, type HelperIdentity } from "../src/helper-client";

const KEY = loadOrCreateSessionKey(mkdtempSync(join(tmpdir(), "dsd-hc-")));
const WRONG_KEY = loadOrCreateSessionKey(mkdtempSync(join(tmpdir(), "dsd-hc-bad-")));

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {} };

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const servers: WebSocketServer[] = [];
const clients: HelperClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) s.close();
});

/**
 * A peer on the helper's port. `key` is what it uses to build its serverProof:
 * the real key = honest helper; a wrong key = squatter that cannot forge the proof.
 */
async function fakeHelper(opts: {
  key: Buffer | null;
  protocolVersion?: number;
}): Promise<{ port: number; received: any[] }> {
  const port = await freePort();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  servers.push(wss);
  const received: any[] = [];

  wss.on("connection", (ws: WebSocket) => {
    const serverNonce = sessionNonce();
    ws.on("error", () => undefined);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: opts.protocolVersion ?? PROTOCOL_VERSION,
        serverNonce,
      }),
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.type === "clientChallenge") {
        const proof =
          opts.key === null
            ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" // garbage
            : sessionProof(opts.key, "S", serverNonce, msg.clientNonce);
        ws.send(JSON.stringify({ type: "serverAuth", serverProof: proof }));
      }
      if (msg.type === "clientAuth") {
        const welcome: WelcomeMessage = {
          type: "welcome",
          helperVersion: "1.0.0",
          buildId: "h-fake",
          pid: 4242,
        };
        ws.send(JSON.stringify(welcome));
      }
    });
  });
  await new Promise((r) => wss.once("listening", r));
  return { port, received };
}

function makeClient(port: number, key: Buffer = KEY) {
  const store = new SpeakerStore();
  const client = new HelperClient({ store, sessionKey: key, port, logger: silentLogger });
  clients.push(client);
  return { store, client };
}

const waitFor = <T>(fn: () => T) => vi.waitFor(fn, { timeout: 3000, interval: 10 });

describe("S3 regression: port-squatter cannot obtain the client secret", () => {
  it("a peer with the WRONG key never receives clientAuth or setCredentials", async () => {
    const { port, received } = await fakeHelper({ key: WRONG_KEY });
    const { store, client } = makeClient(port);
    const onConnected = vi.fn();
    client.on("connected", onConnected);
    client.start();

    await waitFor(() => expect(store.state.helper).toBe("port_conflict"));

    // The plugin answered the challenge, then stopped dead at the bad serverProof.
    expect(received.map((m) => m.type)).toEqual(["clientChallenge"]);
    expect(onConnected).not.toHaveBeenCalled();

    // And an attempted credential send is refused by the auth gate.
    const sent = client.send({
      type: "setCredentials",
      clientId: "123456789012345678",
      clientSecret: "TOP_SECRET",
      userInitiated: true,
    });
    expect(sent).toBe(false);
    expect(JSON.stringify(received)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(received)).not.toContain("clientAuth");
  });

  it("a peer that sends a garbage serverProof is refused identically", async () => {
    const { port, received } = await fakeHelper({ key: null });
    const { store, client } = makeClient(port);
    const onConnected = vi.fn();
    client.on("connected", onConnected);
    client.start();
    await waitFor(() => expect(store.state.helper).toBe("port_conflict"));
    expect(received.some((m) => m.type === "clientAuth")).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("the honest helper completes the handshake and the gate opens", async () => {
    const { port, received } = await fakeHelper({ key: KEY });
    const { store, client } = makeClient(port);
    const identities: HelperIdentity[] = [];
    client.on("connected", (id: HelperIdentity) => identities.push(id));
    client.start();

    await waitFor(() => expect(store.state.helper).toBe("connected"));
    expect(received.map((m) => m.type)).toEqual(["clientChallenge", "clientAuth"]);
    // buildId/pid are only trusted from the post-auth welcome.
    expect(identities[0]).toEqual({ helperVersion: "1.0.0", buildId: "h-fake", pid: 4242 });
    expect(store.state.identity?.pid).toBe(4242);

    const sent = client.send({
      type: "setCredentials",
      clientId: "123456789012345678",
      userInitiated: false,
    });
    expect(sent).toBe(true);
    await waitFor(() => expect(received.map((m) => m.type)).toContain("setCredentials"));
  });

  it("a protocol-mismatched helper is refused (it will idle-exit and be respawned)", async () => {
    // The plugin keeps retrying (link cycles connecting -> down), but never speaks to it
    // and never opens the gate. With no clients the stale helper idle-exits in 120 s and
    // helper-manager spawns the current build.
    const { port, received } = await fakeHelper({ key: KEY, protocolVersion: 1 });
    const { store, client } = makeClient(port);
    const onConnected = vi.fn();
    client.on("connected", onConnected);
    client.start();

    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0); // we said nothing at all
    expect(onConnected).not.toHaveBeenCalled();
    expect(store.state.helper).not.toBe("connected");
  });
});
