import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AuthNeededError,
  ConsentRequiredError,
  OAuthExchangeError,
  PUBLIC_CLIENT_HINT,
  TokenEndpointError,
  createPkcePair,
  ensureAuthenticated,
} from "../src/discord/auth";
import type { DiscordRpcClient } from "../src/discord/rpc-client";
import { TokenStore } from "../src/discord/token-store";
import { HelperLogger } from "../src/logger";

const NOW = 1_000_000_000;

function makeDeps(fetchImpl?: (url: string, init: RequestInit) => Promise<Response>) {
  const logger = new HelperLogger({
    dir: mkdtempSync(join(tmpdir(), "dsd-auth-")),
    mirrorToConsole: false,
    minLevel: "error",
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

function bodyOf(call: unknown[]): URLSearchParams {
  return new URLSearchParams(String((call[1] as RequestInit).body));
}

describe("PKCE", () => {
  it("challenge is base64url(sha256(verifier)) and the verifier is 43 chars", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toHaveLength(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).not.toContain("="); // base64url, unpadded
    expect(createPkcePair().verifier).not.toBe(verifier); // fresh each call
  });
});

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
      expect(body.get("client_secret")).toBe("s");
      expect(body.get("code_verifier")).toBeNull(); // PKCE is not part of the refresh grant
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

  it("a rejected REFRESH stays silent (degradation path if PKCE refresh misbehaves)", async () => {
    // Must NOT surface as OAuthExchangeError — the user gets a clean Re-authorize prompt.
    const store = makeStore();
    store.save({ clientId: "app", clientSecret: "s", refreshToken: "rt", expiresAt: NOW - 1, accessToken: "x" });
    const deps = makeDeps(async () => tokenResponse({ error: "invalid_grant" }, 401));
    const client = mockClient(() => ({}));
    const err = await ensureAuthenticated(client, store, { allowConsentPrompt: false }, deps).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthNeededError);
    expect((err as AuthNeededError).reason).toBe("token_invalid");
    expect(err).not.toBeInstanceOf(OAuthExchangeError);
    expect((err as AuthNeededError).hint).toBeUndefined(); // a secret WAS supplied; no hint to give
  });

  it("a secret-less refresh rejection hints at Public Client (verified live: 401 invalid_client)", async () => {
    // Discord accepts a PKCE code exchange with no secret even when Public Client is OFF,
    // but then rejects the refresh — the session would silently die after 7 days.
    const store = makeStore();
    store.save({ clientId: "app", refreshToken: "rt", expiresAt: NOW - 1, accessToken: "x" });
    const deps = makeDeps(async () => tokenResponse({ error: "invalid_client" }, 401));
    const err = await ensureAuthenticated(mockClient(() => ({})), store, { allowConsentPrompt: false }, deps).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthNeededError);
    expect((err as AuthNeededError).hint).toBe(PUBLIC_CLIENT_HINT);
    expect((err as AuthNeededError).hint).toMatch(/Public Client/);
  });

  it("user-initiated: AUTHORIZE carries the PKCE challenge; exchange carries the verifier", async () => {
    const store = makeStore();
    store.applyCredentials("app", "s");
    let sentChallenge = "";
    const deps = makeDeps(async (_url, init) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("redirect_uri")).toBe("http://127.0.0.1");
      const verifier = body.get("code_verifier")!;
      // The exchange's verifier must hash to the challenge AUTHORIZE advertised.
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(sentChallenge);
      return tokenResponse({ access_token: "at", refresh_token: "rt", expires_in: 604800 });
    });
    const client = mockClient((cmd, args) => {
      if (cmd === "AUTHORIZE") {
        expect(args?.["scopes"]).toEqual(["rpc", "rpc.voice.read"]);
        expect(args?.["response_type"]).toBe("code");
        expect(args?.["code_challenge_method"]).toBe("S256");
        sentChallenge = args?.["code_challenge"] as string;
        expect(sentChallenge).toBeTruthy();
        return { code: "the-code" };
      }
      if (cmd === "AUTHENTICATE") return { user: { id: "u1" } };
      throw new Error(`unexpected ${cmd}`);
    });
    const onConsentPrompt = vi.fn();
    const result = await ensureAuthenticated(
      client,
      store,
      { allowConsentPrompt: true },
      { ...deps, onConsentPrompt },
    );
    expect(onConsentPrompt).toHaveBeenCalledOnce();
    expect(result.auth.accessToken).toBe("at");
  });

  it("PUBLIC CLIENT: with no stored secret, client_secret is omitted from BOTH grants", async () => {
    const store = makeStore();
    store.applyCredentials("app"); // no secret at all
    const deps = makeDeps(async () => tokenResponse({ access_token: "at", refresh_token: "rt", expires_in: 604800 }));
    const client = mockClient((cmd) => {
      if (cmd === "AUTHORIZE") return { code: "c" };
      if (cmd === "AUTHENTICATE") return { user: {} };
      throw new Error(`unexpected ${cmd}`);
    });
    await ensureAuthenticated(client, store, { allowConsentPrompt: true }, deps);

    const codeBody = bodyOf(deps.fetchMock.mock.calls[0]!);
    expect(codeBody.get("client_secret")).toBeNull();
    expect(codeBody.get("code_verifier")).toBeTruthy();

    // Now the refresh grant, also secret-free.
    deps.fetchMock.mockClear();
    const store2 = makeStore();
    store2.save({ clientId: "app", accessToken: "old", refreshToken: "rt", expiresAt: NOW - 1 });
    await ensureAuthenticated(mockClient(() => ({ user: {} })), store2, { allowConsentPrompt: false }, deps);
    const refreshBody = bodyOf(deps.fetchMock.mock.calls[0]!);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("client_secret")).toBeNull();
  });

  it("a rejected CODE exchange is loud, terminal, and never retried", async () => {
    // Public Client OFF + no secret. The code is single-use, so a retry loop is the bug.
    const store = makeStore();
    store.applyCredentials("app");
    const deps = makeDeps(async () => tokenResponse({ error: "invalid_client" }, 401));
    const client = mockClient((cmd) => {
      if (cmd === "AUTHORIZE") return { code: "c" };
      return {};
    });
    const err = await ensureAuthenticated(client, store, { allowConsentPrompt: true }, deps).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OAuthExchangeError);
    expect((err as Error).message).toMatch(/Public Client|Client Secret/);
    expect(deps.fetchMock).toHaveBeenCalledTimes(1); // exactly one attempt
    const authorizeCalls = client.sendCommand.mock.calls.filter((c) => c[0] === "AUTHORIZE");
    expect(authorizeCalls).toHaveLength(1);
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
