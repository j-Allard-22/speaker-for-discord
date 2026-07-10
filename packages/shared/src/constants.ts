/** Version of the helper<->plugin WS protocol. Bump on breaking message changes. */
export const PROTOCOL_VERSION = 1;

/** Default localhost port the helper binds; overridable via the `helperPort` global setting. */
export const DEFAULT_HELPER_PORT = 39642;

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

/** Helper runtime state root: %LOCALAPPDATA%\DiscordSpeakerHelper (resolved at runtime). */
export const HELPER_STATE_DIRNAME = "DiscordSpeakerHelper";
