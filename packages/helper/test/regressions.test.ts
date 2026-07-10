/**
 * Regression tests for the 2026-07-10 live incident:
 * - plugin settings feedback loop flooded setCredentials (~900/s for 6 min)
 * - connect() dangled 10 s on early socket close ("timed out waiting for READY" spam)
 * - a parked session revived by UNCHANGED credentials earned a consent modal
 * - reauthorize during a pending consent killed the in-flight AUTHORIZE (dead modal)
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AuthNeededError, type AuthDeps } from "../src/discord/auth";
import { encodeFrame, FrameParser, Opcode } from "../src/discord/ipc-transport";
import { DiscordRpcClient, RpcClosedError } from "../src/discord/rpc-client";
import { DiscordSession } from "../src/discord/session";
import { TokenStore } from "../src/discord/token-store";
import { HelperLogger } from "../src/logger";
import { SpeakerTracker } from "../src/speaker-tracker";

class MockSocket extends EventEmitter {
  frames: Array<{ op: number; payload: Record<string, unknown> }> = [];
  private parser = new FrameParser();
  constructor() {
    super();
    this.parser.on("frame", (op: number, payload: unknown) =>
      this.frames.push({ op, payload: payload as Record<string, unknown> }),
    );
  }
  write(buf: Buffer): boolean {
    this.parser.push(buf);
    return true;
  }
  destroy(): void {
    this.emit("close");
  }
  reply(op: number, payload: unknown): void {
    this.emit("data", encodeFrame(op as 0 | 1 | 2 | 3 | 4, payload));
  }
}

function tmpLogger(): HelperLogger {
  return new HelperLogger({ dir: mkdtempSync(join(tmpdir(), "dsd-reg-")), mirrorToConsole: false });
}

describe("connect() early-close handling", () => {
  it("rejects promptly when the socket dies mid-handshake — no 10s dangle", async () => {
    const socket = new MockSocket();
    const client = new DiscordRpcClient({
      clientId: "app",
      discover: async () => socket as unknown as net.Socket,
      readyTimeoutMs: 10_000, // the bug would make this test take 10s and blow the timeout
    });
    const pending = client.connect();
    await new Promise((r) => setImmediate(r)); // handshake written
    const started = Date.now();
    socket.destroy(); // Discord quit / restart() closed us
    const err = await pending.catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(RpcClosedError);
    expect((err as RpcClosedError).kind).toBe("closed");
  });

  it("classifies a CLOSE frame as kind=rejected (bad client id)", async () => {
    const socket = new MockSocket();
    const client = new DiscordRpcClient({
      clientId: "bogus",
      discover: async () => socket as unknown as net.Socket,
    });
    const pending = client.connect();
    await new Promise((r) => setImmediate(r));
    socket.reply(Opcode.CLOSE, { code: 4000, message: "Invalid Client ID" });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcClosedError);
    expect((err as RpcClosedError).kind).toBe("rejected");
    expect((err as RpcClosedError).code).toBe(4000);
  });
});

describe("session consent discipline", () => {
  function parkedSessionHarness() {
    const store = new TokenStore(mkdtempSync(join(tmpdir(), "dsd-reg-store-")));
    store.save({ clientId: "app", clientSecret: "s" }); // no tokens -> silent ladder fails
    const consentFlags: boolean[] = [];
    const session = new DiscordSession({
      store,
      tracker: new SpeakerTracker({ switchDebounceMs: 0, idleHoldMs: 0 }),
      logger: tmpLogger(),
      clientFactory: () =>
        ({
          connect: async () => ({}),
          close: () => undefined,
          isClosed: false,
          on: () => undefined,
          once: (_: string, __: () => void) => undefined,
          removeListener: () => undefined,
        }) as never,
      authFn: (async (_c, _s, opts) => {
        consentFlags.push(opts.allowConsentPrompt);
        if (!opts.allowConsentPrompt) throw new AuthNeededError("token_invalid");
        return { user: { id: "u" }, auth: store.load()! };
      }) as never,
      sleepFn: async () => undefined,
    });
    return { session, store, consentFlags };
  }

  it("a plugin reconnect pushing UNCHANGED credentials revives silently — never a modal", async () => {
    const { session, consentFlags } = parkedSessionHarness();
    const authRequired: string[] = [];
    session.on("authRequired", (r: string) => authRequired.push(r));

    session.startFromStored(); // boot: silent -> parks
    await vi.waitFor(() => expect(authRequired).toContain("token_invalid"));

    // The incident: this used to pass userInitiated straight to the consent flag.
    session.setCredentials("app", "s", true); // same creds as stored
    await vi.waitFor(() => expect(consentFlags.length).toBeGreaterThanOrEqual(2));
    expect(consentFlags.every((f) => f === false)).toBe(true); // NO consent, ever
  });

  it("reauthorize (explicit user action) IS allowed to prompt", async () => {
    const { session, consentFlags } = parkedSessionHarness();
    session.startFromStored();
    await vi.waitFor(() => expect(consentFlags).toEqual([false]));
    session.reauthorize();
    await vi.waitFor(() => expect(consentFlags).toContain(true));
    session.stop();
  });

  it("reauthorize while a consent modal is pending is IGNORED (no dead modals)", async () => {
    const store = new TokenStore(mkdtempSync(join(tmpdir(), "dsd-reg-store2-")));
    store.save({ clientId: "app", clientSecret: "s", accessToken: "at", refreshToken: "rt" });
    let authCalls = 0;
    const session = new DiscordSession({
      store,
      tracker: new SpeakerTracker({ switchDebounceMs: 0, idleHoldMs: 0 }),
      logger: tmpLogger(),
      clientFactory: () =>
        ({
          connect: async () => ({}),
          close: () => undefined,
          isClosed: false,
          on: () => undefined,
          once: () => undefined,
          removeListener: () => undefined,
        }) as never,
      authFn: (async (_c, _s, _opts, deps: AuthDeps) => {
        authCalls++;
        deps.onConsentPrompt?.(); // consent modal now "open"
        await new Promise(() => undefined); // hangs, like a real user staring at the modal
        return { user: {}, auth: store.load()! };
      }) as never,
      sleepFn: async () => undefined,
    });
    session.setCredentials("app", "s2", true); // changed secret -> restart with consent
    await vi.waitFor(() => expect(session.status.discord).toBe("authorizing"));
    expect(authCalls).toBe(1);

    session.reauthorize(); // the incident: this used to kill the pending AUTHORIZE
    await new Promise((r) => setTimeout(r, 50));
    expect(authCalls).toBe(1); // still the SAME auth attempt; modal not superseded
    expect(store.load()?.accessToken).toBe("at"); // tokens NOT wiped by ignored click
    session.stop();
  });
});
