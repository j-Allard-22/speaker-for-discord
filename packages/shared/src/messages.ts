/**
 * Helper <-> plugin WebSocket protocol. One JSON object per WS text message,
 * discriminated on `type`.
 *
 * Rules (enforced by both sides):
 * - Snapshot-on-connect: helper sends `hello`, `status`, `channel`, `speaker` (in that
 *   order) to every newly connected client.
 * - Hello-gate: the plugin sends NOTHING (especially `setCredentials`) until it has
 *   received a valid `hello` with a matching `protocolVersion`.
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

// ---------- helper -> plugin ----------

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
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
  | HelloMessage
  | StatusMessage
  | ChannelMessage
  | SpeakerMessage
  | AuthRequiredMessage
  | ErrorMessage;

// ---------- plugin -> helper ----------

export interface SetCredentialsMessage {
  type: "setCredentials";
  clientId: string;
  clientSecret: string;
}

export interface GetStateMessage {
  type: "getState";
}

/** Wipe stored tokens and run a full AUTHORIZE (consent modal) — user-initiated only. */
export interface ReauthorizeMessage {
  type: "reauthorize";
}

/** Graceful exit (helper upgrades, dev restarts). */
export interface ShutdownMessage {
  type: "shutdown";
}

export type PluginToHelperMessage =
  | SetCredentialsMessage
  | GetStateMessage
  | ReauthorizeMessage
  | ShutdownMessage;

// ---------- parsing helpers ----------

const HELPER_TO_PLUGIN_TYPES = new Set([
  "hello",
  "status",
  "channel",
  "speaker",
  "authRequired",
  "error",
]);

const PLUGIN_TO_HELPER_TYPES = new Set([
  "setCredentials",
  "getState",
  "reauthorize",
  "shutdown",
]);

/** Parse a raw WS payload into a helper->plugin message, or null if malformed/unknown. */
export function parseHelperMessage(raw: unknown): HelperToPluginMessage | null {
  const msg = parseJsonObject(raw);
  if (msg !== null && HELPER_TO_PLUGIN_TYPES.has(msg["type"] as string)) {
    return msg as unknown as HelperToPluginMessage;
  }
  return null;
}

/** Parse a raw WS payload into a plugin->helper message, or null if malformed/unknown. */
export function parsePluginMessage(raw: unknown): PluginToHelperMessage | null {
  const msg = parseJsonObject(raw);
  if (msg !== null && PLUGIN_TO_HELPER_TYPES.has(msg["type"] as string)) {
    return msg as unknown as PluginToHelperMessage;
  }
  return null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
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
