import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AuthNeededError,
  ConsentRequiredError,
  ensureAuthenticated,
  TokenEndpointError,
} from "../src/discord/auth";
import type { DiscordRpcClient } from "../src/discord/rpc-client";
import { TokenStore } from "../src/discord/token-store";
import { HelperLogger } from "../src/logger";

const NOW = 1_000_000_000;

function makeDeps(fetchImpl?: (url: string, init: RequestInit) => Promise<Response>) {
  const logger = new HelperLogger({
    dir: mkdtempSync(join(tmpdir(), "dsd-auth-")),
    mirrorToConsole: false,
  });
  const fetchFn = vi.fn(fetchImpl ?? (() => Promise.reject(new Error("no fetch expected"))));
  return {
    logger,
    fetchFn: fetchFn as unknown as typeof fetch,
    fetchMock: fetchFn,
    now: () => NOW,
    authorizeTimeoutMs: 100,
  };
}

function makeStore(): TokenStore {
  return new TokenStore(mkdtempSync(join(tmpdir(), "dsd-auth-store-")));
}

function mockClient(handler: (cmd: string, args?: Record<string, unknown>) => unknown) {
  return {
    sendCommand: vi.fn(async (cmd: string, args?: Record<string, unknown>) => handler(cmd, args)),
  } as unknown as DiscordRpcClient & { sendCommand: ReturnType<typeof vi.fn> };
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("ensureAuthenticated ladder", () => {
  it("fast path: fresh stored token -> AUTHENTICATE only, no fetch, no consent", async () => {
    const store = makeStore();
    store.save({
      clientId: "app",
      clientSecret: "s",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: NOW + 100_000,
    });
    const client = mockClient((cmd) => {
      if (cmd === "AUTHENTICATE") return { user: { id: "u1" } };
      throw new Error(`unexpected ${cmd}`);
    });
    const deps = makeDeps();
    const result = await ensureAuthenticated(client, store, { allowConsentPrompt: false }, deps);
    expect(result.user.id).toBe("u1");
    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it("expired token -> silent refresh with rotation -> AUTHENTICATE", async () => {
    const store = makeStore();
    store.save({
      clientId: "app",
      clientSecret: "s",
      accessToken: "expired",
      refreshToken: "rt-old",
      expiresAt: NOW - 1,
    });
    const deps = makeDeps(async (_url, init) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt-old");
      return tokenResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 604800 });
    });
    const client = mockClient((cmd, args) => {
      if (cmd === "AUTHENTICATE") {
        expect(args?.["access_token"]).toBe("at-new");
        return { user: { id: "u1" } };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    await ensureAuthenticated(client, store, { allowConsentPrompt: false }, deps);
    expect(store.load()?.refreshToken).toBe("rt-new"); // rotated + persisted
  });

  it("boot path STOPS at refresh failure — parks instead of popping the modal", async () => {
    const store = makeStore();
    store.save({
      clientId: "app",
      clientSecret: "s",
      accessToken: "expired",
      refreshToken: "rt-dead",
      expiresAt: NOW - 1,
    });
    const deps = makeDeps(async () => tokenResponse({ error: "invalid_grant" }, 400));
    const client = mockClient((cmd) => {
      if (cmd === "AUTHORIZE") throw new Error("AUTHORIZE must not run on the boot path");
      return {};
    });
    await expect(
      ensureAuthenticated(client, store, { allowConsentPrompt: false }, deps),
    ).rejects.toThrowError(AuthNeededError);
    expect(client.sendCommand).not.toHaveBeenCalledWith("AUTHORIZE", expect.anything());
  });

  it("user-initiated path runs the full AUTHORIZE -> exchange -> AUTHENTICATE flow", async () => {
    const store = makeStore();
    store.applyCredentials("app", "s");
    const deps = makeDeps(async (_url, init) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("redirect_uri")).toBe("http://127.0.0.1");
      return tokenResponse({ access_token: "at", refresh_token: "rt", expires_in: 604800 });
    });
    const onConsentPrompt = vi.fn();
    const client = mockClient((cmd, args) => {
      if (cmd === "AUTHORIZE") {
        expect(args?.["scopes"]).toEqual(["rpc", "rpc.voice.read"]);
        expect(args?.["response_type"]).toBe("code");
        return { code: "the-code" };
      }
      if (cmd === "AUTHENTICATE") return { user: { id: "u1" } };
      throw new Error(`unexpected ${cmd}`);
    });
    const result = await ensureAuthenticated(
      client,
      store,
      { allowConsentPrompt: true },
      { ...deps, onConsentPrompt },
    );
    expect(onConsentPrompt).toHaveBeenCalledOnce();
    expect(result.auth.accessToken).toBe("at");
    expect(store.load()?.accessToken).toBe("at");
  });

  it("consent denial surfaces as ConsentRequiredError", async () => {
    const store = makeStore();
    store.applyCredentials("app", "s");
    const client = mockClient((cmd) => {
      if (cmd === "AUTHORIZE") throw new Error("User denied authorization");
      return {};
    });
    await expect(
      ensureAuthenticated(client, store, { allowConsentPrompt: true }, makeDeps()),
    ).rejects.toThrowError(ConsentRequiredError);
  });

  it("network failure at the token endpoint is retryable (propagates as network kind)", async () => {
    const store = makeStore();
    store.save({
      clientId: "app",
      clientSecret: "s",
      accessToken: "expired",
      refreshToken: "rt",
      expiresAt: NOW - 1,
    });
    const deps = makeDeps(async () => {
      throw new Error("ENOTFOUND discord.com");
    });
    const client = mockClient(() => ({}));
    const err = await ensureAuthenticated(client, store, { allowConsentPrompt: true }, deps).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TokenEndpointError);
    expect((err as TokenEndpointError).kind).toBe("network");
  });

  it("no stored credentials at all -> AuthNeededError(no_credentials)", async () => {
    const client = mockClient(() => ({}));
    await expect(
      ensureAuthenticated(client, makeStore(), { allowConsentPrompt: true }, makeDeps()),
    ).rejects.toThrowError(AuthNeededError);
  });
});
