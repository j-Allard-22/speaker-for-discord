/**
 * Helper <-> plugin WebSocket protocol. One JSON object per WS text message,
 * discriminated on `type`.
 *
 * Two disjoint message families, parsed by SEPARATE functions:
 *
 *  - HANDSHAKE (pre-auth): hello / clientChallenge / serverAuth / clientAuth.
 *    Parsed by parseHandshake{Server,Client}Message. Keeping these out of the app
 *    parsers means an attacker cannot slip an app message in before authenticating.
 *
 *  - APPLICATION (post-auth): welcome + state pushes one way, commands the other.
 *    The helper sends NOTHING from this family until the client proves it holds the
 *    session key; the plugin sends nothing until it has verified the server's proof.
 *
 * Field validation is per-type (not just the `type` discriminator) — defence in depth
 * behind the handshake gate.
 */

/** A voice-channel member, resolved and ready to render. */
export interface MemberInfo {
  userId: string;
  /** Precedence: guild nick -> global_name -> username. */
  displayName: string;
  /** Ready-to-fetch CDN URL (custom avatar or correct default-avatar variant). */
  avatarUrl: string;
}

export type DiscordStatus =
  | "disconnected"
  | "connecting"
  | "awaiting_credentials"
  | "authorizing"
  | "authenticating"
  | "no_channel"
  | "subscribed";

// ---------- handshake: helper -> plugin ----------

/** Sent to every connector. Deliberately carries ZERO state — not even the helper pid. */
export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  serverNonce: string;
}

export interface ServerAuthMessage {
  type: "serverAuth";
  serverProof: string;
}

export type HandshakeServerMessage = HelloMessage | ServerAuthMessage;

// ---------- handshake: plugin -> helper ----------

export interface ClientChallengeMessage {
  type: "clientChallenge";
  clientNonce: string;
}

export interface ClientAuthMessage {
  type: "clientAuth";
  clientProof: string;
}

export type HandshakeClientMessage = ClientChallengeMessage | ClientAuthMessage;

// ---------- application: helper -> plugin ----------

/** First post-auth message. Carries the identity the helper-manager needs to decide swaps. */
export interface WelcomeMessage {
  type: "welcome";
  helperVersion: string;
  buildId: string;
  pid: number;
}

export interface StatusMessage {
  type: "status";
  discord: DiscordStatus;
  detail?: string;
}

export interface ChannelMessage {
  type: "channel";
  channelId: string | null;
  guildId: string | null;
  channelName: string | null;
  members: MemberInfo[];
}

export interface SpeakerMessage {
  type: "speaker";
  /** null = idle (nobody speaking). */
  speaker: MemberInfo | null;
  speakingCount: number;
}

export interface AuthRequiredMessage {
  type: "authRequired";
  reason: "no_credentials" | "consent_required" | "token_invalid";
}

export interface ErrorMessage {
  type: "error";
  code: "port_conflict" | "oauth_exchange_failed" | "rpc_error" | "internal";
  message: string;
  /** true -> helper keeps retrying by itself; false -> waits for user action (PI). */
  recoverable: boolean;
}

export type HelperToPluginMessage =
  | WelcomeMessage
  | StatusMessage
  | ChannelMessage
  | SpeakerMessage
  | AuthRequiredMessage
  | ErrorMessage;

// ---------- application: plugin -> helper ----------

export interface SetCredentialsMessage {
  type: "setCredentials";
  clientId: string;
  /** Optional: omitted when the user's app has the Public Client flag (PKCE-only). */
  clientSecret?: string;
  /**
   * TRUE only for a real property-inspector change. A reconnect push must send FALSE —
   * `userInitiated` is what permits Discord's consent modal, and an unprompted modal
   * (e.g. at Windows login) is a bug. Never hard-code this.
   */
  userInitiated: boolean;
}

export interface GetStateMessage {
  type: "getState";
}

/** Wipe stored tokens and run a full AUTHORIZE (consent modal) — user-initiated only. */
export interface ReauthorizeMessage {
  type: "reauthorize";
}

/** Wipe stored credentials AND tokens (the user-facing "sign out"/data-deletion path). */
export interface ForgetCredentialsMessage {
  type: "forgetCredentials";
}

/** Graceful exit (helper upgrades, dev restarts). */
export interface ShutdownMessage {
  type: "shutdown";
}

export type PluginToHelperMessage =
  | SetCredentialsMessage
  | GetStateMessage
  | ReauthorizeMessage
  | ForgetCredentialsMessage
  | ShutdownMessage;

// ---------- parsing ----------

/** Discord snowflakes are 17-20 digits today; the bound also caps what reaches auth.json. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MAX_SECRET_LENGTH = 200;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_PROOF_LENGTH = 128; // base64 of a 32-byte HMAC is 44 chars

function asObject(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
  if (typeof raw === "string" || raw instanceof Uint8Array) {
    try {
      value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  return typeof obj["type"] === "string" ? obj : null;
}

function isProof(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROOF_LENGTH;
}

function isNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

/** Handshake frames the PLUGIN accepts (pre-auth). Never returns application messages. */
export function parseHandshakeServerMessage(raw: unknown): HandshakeServerMessage | null {
  const m = asObject(raw);
  if (!m) return null;
  if (m["type"] === "hello") {
    if (typeof m["protocolVersion"] !== "number" || !isNonce(m["serverNonce"])) return null;
    return { type: "hello", protocolVersion: m["protocolVersion"], serverNonce: m["serverNonce"] };
  }
  if (m["type"] === "serverAuth") {
    if (!isProof(m["serverProof"])) return null;
    return { type: "serverAuth", serverProof: m["serverProof"] };
  }
  return null;
}

/** Handshake frames the HELPER accepts (pre-auth). Never returns application messages. */
export function parseHandshakeClientMessage(raw: unknown): HandshakeClientMessage | null {
  const m = asObject(raw);
  if (!m) return null;
  if (m["type"] === "clientChallenge") {
    if (!isNonce(m["clientNonce"])) return null;
    return { type: "clientChallenge", clientNonce: m["clientNonce"] };
  }
  if (m["type"] === "clientAuth") {
    if (!isProof(m["clientProof"])) return null;
    return { type: "clientAuth", clientProof: m["clientProof"] };
  }
  return null;
}

/** Application messages the PLUGIN accepts (post-auth only). */
export function parseHelperMessage(raw: unknown): HelperToPluginMessage | null {
  const m = asObject(raw);
  if (!m) return null;
  switch (m["type"]) {
    case "welcome":
      if (
        typeof m["helperVersion"] !== "string" ||
        typeof m["buildId"] !== "string" ||
        typeof m["pid"] !== "number"
      ) {
        return null;
      }
      return {
        type: "welcome",
        helperVersion: m["helperVersion"],
        buildId: m["buildId"],
        pid: m["pid"],
      };
    case "status":
    case "channel":
    case "speaker":
    case "authRequired":
    case "error":
      // These originate from our own authenticated helper; shape is trusted.
      return m as unknown as HelperToPluginMessage;
    default:
      return null;
  }
}

/** Application messages the HELPER accepts (post-auth only), with per-type field validation. */
export function parsePluginMessage(raw: unknown): PluginToHelperMessage | null {
  const m = asObject(raw);
  if (!m) return null;
  switch (m["type"]) {
    case "setCredentials": {
      const clientId = m["clientId"];
      const clientSecret = m["clientSecret"];
      const userInitiated = m["userInitiated"];
      if (typeof clientId !== "string" || !SNOWFLAKE_PATTERN.test(clientId)) return null;
      if (typeof userInitiated !== "boolean") return null;
      if (clientSecret !== undefined) {
        if (typeof clientSecret !== "string" || clientSecret.length > MAX_SECRET_LENGTH) return null;
      }
      return {
        type: "setCredentials",
        clientId,
        ...(clientSecret !== undefined && clientSecret !== "" ? { clientSecret } : {}),
        userInitiated,
      };
    }
    case "getState":
      return { type: "getState" };
    case "reauthorize":
      return { type: "reauthorize" };
    case "forgetCredentials":
      return { type: "forgetCredentials" };
    case "shutdown":
      return { type: "shutdown" };
    default:
      return null;
  }
}
