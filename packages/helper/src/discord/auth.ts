/**
 * Auth ladder (in order):
 *   1. Stored access token still fresh  -> AUTHENTICATE            (no consent dialog)
 *   2. Expired/rejected + refresh token -> refresh grant -> AUTHENTICATE
 *   3. Otherwise:
 *        - boot/reconnect path (allowConsentPrompt=false): STOP -> AuthNeededError.
 *          The consent modal must NEVER pop unprompted (e.g. at Windows login).
 *        - user-initiated path (Save & Connect / Re-authorize): AUTHORIZE over IPC
 *          (consent modal in the Discord client, 120 s timeout) -> code -> token
 *          exchange -> AUTHENTICATE.
 *
 * PKCE: every AUTHORIZE carries a `code_challenge` (S256) and every code exchange the
 * matching `code_verifier`. When the user's app has the Public Client flag they need no
 * client secret at all — then the secret exists nowhere: not in Stream Deck's settings,
 * not on the localhost socket, not on disk. We send `client_secret` iff the user gave one.
 *
 * Scope note: `rpc.voice.read` gates the voice events; the legacy docs' scope name
 * `rpc.notifications.read` is wrong. The token exchange must cite a redirect_uri
 * registered verbatim in the Dev Portal even though nothing listens on it.
 */
import { createHash, randomBytes } from "node:crypto";
import { DISCORD_SCOPES, REDIRECT_URI } from "@dsd/shared";
import type { HelperLogger } from "../logger.js";
import type { DiscordRpcClient } from "./rpc-client.js";
import type { StoredAuth, TokenStore } from "./token-store.js";

const TOKEN_ENDPOINT = "https://discord.com/api/oauth2/token";
const AUTHORIZE_TIMEOUT_MS = 120_000;

/**
 * Boot path hit the end of the silent ladder; user must act in the PI.
 * `hint` is surfaced in the property inspector when we can explain *why*.
 */
export class AuthNeededError extends Error {
  constructor(
    readonly reason: "no_credentials" | "token_invalid",
    readonly hint?: string,
  ) {
    super(`authentication required: ${reason}`);
    this.name = "AuthNeededError";
  }
}

/**
 * Verified against Discord 2026-07: an `authorization_code` exchange carrying a
 * `code_verifier` succeeds with NO `client_secret` even when the app lacks the
 * PUBLIC_OAUTH2_CLIENT flag — but the `refresh_token` grant then returns
 * `401 invalid_client`. So a user who leaves the secret blank *without* enabling
 * "Public Client" logs in fine and then silently loses the session a week later.
 * We can't fix that for them, but we can say exactly what to do about it.
 */
export const PUBLIC_CLIENT_HINT =
  "Token refresh needs either 'Public Client' enabled on your app's OAuth2 tab, or a Client Secret.";

/** User denied the consent modal, or it timed out. */
export class ConsentRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentRequiredError";
  }
}

/** Token endpoint unreachable (network) vs rejected the grant (dead tokens/bad secret). */
export class TokenEndpointError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "rejected",
  ) {
    super(message);
    this.name = "TokenEndpointError";
  }
}

/**
 * Discord rejected the authorization_code exchange. Almost always: the app has Public
 * Client OFF and no secret was supplied. Non-recoverable and user-actionable — the code
 * is single-use, so retrying is pointless (and was the source of a silent retry loop).
 */
export class OAuthExchangeError extends Error {
  constructor(readonly detail: string) {
    super(
      "Discord rejected the token exchange. On your app's OAuth2 tab enable " +
        "'Public Client' — or paste the Client Secret in the key settings.",
    );
    this.name = "OAuthExchangeError";
  }
}

export interface AuthResult {
  user: { id?: string; username?: string };
  auth: StoredAuth;
}

export interface AuthDeps {
  logger: HelperLogger;
  /** Invoked right before AUTHORIZE (the consent modal) — lets the session emit "authorizing". */
  onConsentPrompt?: () => void;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  now?: () => number;
  authorizeTimeoutMs?: number;
}

/** RFC 7636 S256: verifier is 43 base64url chars; challenge = base64url(sha256(verifier)). */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function ensureAuthenticated(
  client: DiscordRpcClient,
  store: TokenStore,
  opts: { allowConsentPrompt: boolean },
  deps: AuthDeps,
): Promise<AuthResult> {
  const now = deps.now ?? Date.now;
  let auth = store.load();
  if (!auth) throw new AuthNeededError("no_credentials");

  // 1. Fast path: stored token still fresh.
  if (auth.accessToken && (auth.expiresAt ?? 0) > now()) {
    try {
      const user = await authenticate(client, auth.accessToken);
      deps.logger.info("authenticated with stored token");
      return { user, auth };
    } catch (err) {
      deps.logger.warn("stored token rejected; trying refresh", { message: String(err) });
    }
  }

  // 2. Refresh grant. A REJECTED refresh stays silent and falls through to the ladder's
  //    end — the user gets a clean "Authorize" prompt, never a silent loop.
  let hint: string | undefined;
  if (auth.refreshToken) {
    try {
      const tokens = await requestToken(
        {
          client_id: auth.clientId,
          grant_type: "refresh_token",
          refresh_token: auth.refreshToken,
          ...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
        },
        deps,
      );
      auth = store.saveTokens(auth, tokens, now());
      const user = await authenticate(client, auth.accessToken!);
      deps.logger.info("authenticated after silent refresh");
      return { user, auth };
    } catch (err) {
      if (err instanceof TokenEndpointError && err.kind === "network") throw err; // retryable
      // Discord rejects a secret-less refresh unless the app is a Public Client. Without
      // this hint the user just sees "Authorize" reappear every week for no stated reason.
      if (err instanceof TokenEndpointError && err.kind === "rejected" && !auth.clientSecret) {
        hint = PUBLIC_CLIENT_HINT;
      }
      deps.logger.warn("refresh failed; tokens are dead", {
        message: String(err),
        ...(hint !== undefined && { hint }),
      });
    }
  }

  // 3. Full AUTHORIZE — user-initiated only.
  if (!opts.allowConsentPrompt) {
    throw new AuthNeededError("token_invalid", hint);
  }

  const { verifier, challenge } = createPkcePair();

  deps.logger.info("running AUTHORIZE (consent modal in Discord)", { pkce: true });
  deps.onConsentPrompt?.();
  let code: string;
  try {
    const data = (await withTimeout(
      client.sendCommand("AUTHORIZE", {
        client_id: auth.clientId,
        scopes: [...DISCORD_SCOPES],
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      deps.authorizeTimeoutMs ?? AUTHORIZE_TIMEOUT_MS,
      "consent dialog timed out",
    )) as Record<string, unknown>;
    if (typeof data?.["code"] !== "string") throw new Error("AUTHORIZE returned no code");
    code = data["code"] as string;
  } catch (err) {
    throw new ConsentRequiredError(err instanceof Error ? err.message : String(err));
  }

  let tokens: TokenResponse;
  try {
    tokens = await requestToken(
      {
        client_id: auth.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        ...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
      },
      deps,
    );
  } catch (err) {
    // A rejected code exchange is LOUD and terminal — the code is single-use.
    if (err instanceof TokenEndpointError && err.kind === "rejected") {
      throw new OAuthExchangeError(err.message);
    }
    throw err;
  }

  auth = store.saveTokens(auth, tokens, now());
  const user = await authenticate(client, auth.accessToken!);
  deps.logger.info("authenticated after full authorize", { usedSecret: Boolean(auth.clientSecret) });
  return { user, auth };
}

// ---- internals ----

async function authenticate(
  client: DiscordRpcClient,
  accessToken: string,
): Promise<{ id?: string; username?: string }> {
  // NOTE: never log the args of this command (the logger redacts, but don't tempt fate).
  const data = (await client.sendCommand("AUTHENTICATE", { access_token: accessToken })) as {
    user?: { id?: string; username?: string };
  };
  return data?.user ?? {};
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function requestToken(body: Record<string, string>, deps: AuthDeps): Promise<TokenResponse> {
  const fetchFn = deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new TokenEndpointError(`token endpoint unreachable: ${String(err)}`, "network");
  }
  if (!res.ok) {
    // Body may name the OAuth error; status alone is safe to log.
    throw new TokenEndpointError(`token endpoint rejected grant (HTTP ${res.status})`, "rejected");
  }
  const json = (await res.json()) as TokenResponse;
  if (typeof json.access_token !== "string") {
    throw new TokenEndpointError("token endpoint returned no access_token", "rejected");
  }
  return json;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
