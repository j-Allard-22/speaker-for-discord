/**
 * Version of the helper<->plugin WS protocol. Bump on breaking message changes.
 * v2: mutual-auth handshake (hello/clientChallenge/serverAuth/clientAuth/welcome);
 *     no state is disclosed before the client proves it holds the session key.
 */
export const PROTOCOL_VERSION = 2;

/** Default localhost port the helper binds; overridable via the `helperPort` global setting. */
export const DEFAULT_HELPER_PORT = 39642;

/** A peer that hasn't completed the 4-message handshake by then is terminated. */
export const HANDSHAKE_TIMEOUT_MS = 3_000;

/** One plugin normally holds one socket; the slack covers a reload overlap + a dev probe. */
export const MAX_CLIENTS = 4;

/** Largest legit frame (a full roster) is a few KB. Blocks the 100 MiB `ws` default. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** OAuth scopes required for voice events. `rpc.voice.read` gates the SPEAKING and
 * VOICE_STATE events — the legacy docs' `rpc.notifications.read` is wrong/outdated. */
export const DISCORD_SCOPES = ["rpc", "rpc.voice.read"] as const;

/** Must match a redirect registered verbatim in the Discord Dev Portal (nothing listens on it —
 * the RPC flow returns the code over the pipe, but the token exchange must cite it). */
export const REDIRECT_URI = "http://127.0.0.1";

/** Debounce before switching the key to a *different* speaker (kills A/B flicker). */
export const SWITCH_DEBOUNCE_MS = 250;

/** Hold before the key goes idle after the last SPEAKING_STOP (bridges VAD gaps between phrases). */
export const IDLE_HOLD_MS = 1500;

/** Helper exits after this long with zero WS clients (orphan prevention). */
export const IDLE_EXIT_MS = 120_000;

/** Helper runtime state root under %LOCALAPPDATA% (resolved by state-dir.ts). */
export const HELPER_STATE_DIRNAME = "SpeakerForDiscord";
