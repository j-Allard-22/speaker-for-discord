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
 * Scope note: `rpc.voice.read` gates the voice events; the legacy docs' scope name
 * `rpc.notifications.read` is wrong. The token exchange must cite a redirect_uri
 * registered verbatim in the Dev Portal even though nothing listens on it.
 */
import { DISCORD_SCOPES, REDIRECT_URI } from "@dsd/shared";
import type { HelperLogger } from "../logger.js";
import type { DiscordRpcClient } from "./rpc-client.js";
import type { StoredAuth, TokenStore } from "./token-store.js";

const TOKEN_ENDPOINT = "https://discord.com/api/oauth2/token";
const AUTHORIZE_TIMEOUT_MS = 120_000;

/** Boot path hit the end of the silent ladder; user must act in the PI. */
export class AuthNeededError extends Error {
  constructor(readonly reason: "no_credentials" | "token_invalid") {
    super(`authentication required: ${reason}`);
    this.name = "AuthNeededError";
  }
}

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

  // 2. Refresh grant.
  if (auth.refreshToken) {
    try {
      const tokens = await requestToken(
        {
          client_id: auth.clientId,
          client_secret: auth.clientSecret,
          grant_type: "refresh_token",
          refresh_token: auth.refreshToken,
        },
        deps,
      );
      auth = store.saveTokens(auth, tokens, now());
      const user = await authenticate(client, auth.accessToken!);
      deps.logger.info("authenticated after silent refresh");
      return { user, auth };
    } catch (err) {
      if (err instanceof TokenEndpointError && err.kind === "network") throw err; // retryable
      deps.logger.warn("refresh failed; tokens are dead", { message: String(err) });
    }
  }

  // 3. Full AUTHORIZE — user-initiated only.
  if (!opts.allowConsentPrompt) {
    throw new AuthNeededError("token_invalid");
  }

  deps.logger.info("running AUTHORIZE (consent modal in Discord)");
  deps.onConsentPrompt?.();
  let code: string;
  try {
    const data = (await withTimeout(
      client.sendCommand("AUTHORIZE", {
        client_id: auth.clientId,
        scopes: [...DISCORD_SCOPES],
        response_type: "code",
      }),
      deps.authorizeTimeoutMs ?? AUTHORIZE_TIMEOUT_MS,
      "consent dialog timed out",
    )) as Record<string, unknown>;
    if (typeof data?.["code"] !== "string") throw new Error("AUTHORIZE returned no code");
    code = data["code"] as string;
  } catch (err) {
    throw new ConsentRequiredError(err instanceof Error ? err.message : String(err));
  }

  const tokens = await requestToken(
    {
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    },
    deps,
  );
  auth = store.saveTokens(auth, tokens, now());
  const user = await authenticate(client, auth.accessToken!);
  deps.logger.info("authenticated after full authorize");
  return { user, auth };
}

// ---- internals ----

async function authenticate(
  client: DiscordRpcClient,
  accessToken: string,
): Promise<{ id?: string; username?: string }> {
  // NOTE: never log the args of this command (logger redacts, but don't tempt fate).
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
    // Body may contain error codes; safe to log status only.
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
