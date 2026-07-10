/**
 * DiscordSession: owns the connection lifecycle.
 *
 *   IDLE -> CONNECTING -> AUTH -> FETCHING_CHANNEL -> (SUBSCRIBED | NO_CHANNEL)
 *   failure -> WAITING_RETRY (backoff) -> CONNECTING
 *   needs-user -> AWAITING_USER (parked until setCredentials/reauthorize)
 *
 * Backoff has TWO failure classes (rate-limit safety — Discord allows ~2 conn/min):
 *  (a) pipe refused (Discord not running; consumed no server connection):
 *      2 s -> x2 -> cap 30 s, jitter UPWARD only (up to +20%).
 *  (b) connected-then-failed (handshake rejected, auth error, early close):
 *      additionally enforce >= 31 s between server-accepted connection attempts.
 *
 * Channel bootstrap is race-safe: a monotonic generation counter is bumped by every
 * VOICE_CHANNEL_SELECT; after every await the bootstrap checks it and abandons if
 * stale. Events arriving between SUBSCRIBE and the GET_CHANNEL roster install are
 * buffered and replayed onto the roster.
 */
import { EventEmitter } from "node:events";
import type { DiscordStatus } from "@dsd/shared";
import type { HelperLogger } from "../logger.js";
import type { RawVoiceState, SpeakerTracker } from "../speaker-tracker.js";
import {
  AuthNeededError,
  ConsentRequiredError,
  TokenEndpointError,
  ensureAuthenticated,
} from "./auth.js";
import { NoDiscordError } from "./ipc-transport.js";
import { DiscordRpcClient, RpcClosedError } from "./rpc-client.js";
import type { TokenStore } from "./token-store.js";

const CHANNEL_EVENTS = [
  "VOICE_STATE_CREATE",
  "VOICE_STATE_UPDATE",
  "VOICE_STATE_DELETE",
  "SPEAKING_START",
  "SPEAKING_STOP",
] as const;

const MIN_SERVER_ATTEMPT_GAP_MS = 31_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

export interface ChannelInfo {
  channelId: string | null;
  guildId: string | null;
  channelName: string | null;
}

export interface SessionDeps {
  store: TokenStore;
  tracker: SpeakerTracker;
  logger: HelperLogger;
  /** Injectable for tests. */
  clientFactory?: (clientId: string) => DiscordRpcClient;
  authFn?: typeof ensureAuthenticated;
  now?: () => number;
  rand?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Events:
 * - "status" (s: DiscordStatus, detail?: string)
 * - "authRequired" (reason: "no_credentials" | "consent_required" | "token_invalid")
 * - "channel" (info: ChannelInfo)   — roster changes flow via the tracker's own events
 * - "fatal" (message: string)       — non-recoverable until user acts (bad client id, …)
 */
export class DiscordSession extends EventEmitter {
  private client: DiscordRpcClient | null = null;
  private running = false;
  private stopped = false;
  private generation = 0;
  private currentChannelId: string | null = null;
  private channelInfo: ChannelInfo = { channelId: null, guildId: null, channelName: null };
  private bootstrapBuffer: Array<{ evt: string; data: Record<string, unknown> }> | null = null;

  private backoffExp = 0;
  private lastServerConnectAt = 0;
  private handshakeRejections = 0;
  private wakeSleep: (() => void) | null = null;

  private lastStatus: DiscordStatus = "disconnected";
  private lastDetail: string | undefined;

  constructor(private readonly deps: SessionDeps) {
    super();
  }

  get status(): { discord: DiscordStatus; detail?: string } {
    return { discord: this.lastStatus, detail: this.lastDetail };
  }

  get channel(): ChannelInfo {
    return this.channelInfo;
  }

  /**
   * Called on every plugin (re)connect and whenever settings change. Idempotent:
   * - running + unchanged credentials: no-op.
   * - parked + unchanged credentials: SILENT revive (a plugin reconnect must never
   *   earn a consent modal — that's what Re-authorize is for).
   * - changed credentials: restart; consent allowed only when the change came from
   *   an explicit user action in the PI.
   */
  setCredentials(clientId: string, clientSecret: string, userInitiated: boolean): void {
    const before = this.deps.store.load();
    const changed = !before || before.clientId !== clientId || before.clientSecret !== clientSecret;
    this.deps.store.applyCredentials(clientId, clientSecret);
    if (this.running && !changed) return;
    this.restart(changed && userInitiated);
  }

  /** User pressed Re-authorize: wipe tokens, full AUTHORIZE (consent modal allowed). */
  reauthorize(): void {
    if (this.lastStatus === "authorizing") {
      // A consent modal is ALREADY open in Discord. Restarting now would kill the
      // pending AUTHORIZE — the user would accept a dead modal and "nothing happens".
      this.deps.logger.info("reauthorize ignored: consent modal already pending");
      return;
    }
    const auth = this.deps.store.load();
    if (!auth) {
      this.setStatus("awaiting_credentials");
      this.emit("authRequired", "no_credentials");
      return;
    }
    this.deps.store.save({ clientId: auth.clientId, clientSecret: auth.clientSecret });
    this.restart(true);
  }

  /** Boot path (no consent modal allowed). No-op without stored credentials. */
  startFromStored(): void {
    if (!this.deps.store.load()) {
      this.setStatus("awaiting_credentials");
      this.emit("authRequired", "no_credentials");
      return;
    }
    if (this.running) return;
    void this.runLoop(false);
  }

  stop(): void {
    this.stopped = true;
    this.wakeSleep?.();
    this.client?.close();
  }

  // ---- run loop ----

  private restart(allowConsentPrompt: boolean): void {
    // Kill any live connection; if a loop is running it notices the close/wake and
    // loops again (restartRequested prevents it from parking on the induced error).
    this.generation++;
    this.client?.close();
    this.client = null;
    if (!this.running) {
      void this.runLoop(allowConsentPrompt);
    } else {
      this.restartRequested = true;
      this.pendingConsentAllowed = this.pendingConsentAllowed || allowConsentPrompt;
      this.wakeSleep?.();
    }
  }

  private pendingConsentAllowed = false;
  private restartRequested = false;

  private async runLoop(allowConsentPromptFirst: boolean): Promise<void> {
    this.running = true;
    this.stopped = false;
    this.handshakeRejections = 0; // a revival earns fresh chances
    let allowConsentPrompt = allowConsentPromptFirst;

    while (!this.stopped) {
      allowConsentPrompt = allowConsentPrompt || this.pendingConsentAllowed;
      this.pendingConsentAllowed = false;
      this.restartRequested = false;

      const auth = this.deps.store.load();
      if (!auth) {
        this.setStatus("awaiting_credentials");
        this.emit("authRequired", "no_credentials");
        break;
      }

      this.setStatus("connecting");
      const client = this.makeClient(auth.clientId);
      this.client = client;

      let serverAccepted = false;
      try {
        await client.connect(); // resolves on READY
        serverAccepted = true;
        this.lastServerConnectAt = this.deps.now?.() ?? Date.now();
        this.handshakeRejections = 0;
        this.backoffExp = 0; // successful handshake resets the ramp

        this.setStatus("authenticating");
        await (this.deps.authFn ?? ensureAuthenticated)(
          client,
          this.deps.store,
          { allowConsentPrompt },
          {
            logger: this.deps.logger,
            now: this.deps.now,
            onConsentPrompt: () => this.setStatus("authorizing", "check the Discord app"),
          },
        );
        allowConsentPrompt = false; // consumed; future silent reconnects stay silent

        this.wireDispatch(client);
        await this.postAuthBootstrap(client);

        // Healthy session: wait for the pipe to die, then loop for a reconnect.
        await this.waitForClose(client);
        this.deps.tracker.clear();
        this.setChannel({ channelId: null, guildId: null, channelName: null });
        this.setStatus("disconnected", "Discord connection lost");
        continue;
      } catch (err) {
        client.close();
        this.deps.tracker.clear();
        this.setChannel({ channelId: null, guildId: null, channelName: null });

        if (this.stopped) break;

        // A restart request that arrived mid-failure must revive, not park.
        const parkOrContinue = (): "park" | "continue" =>
          this.restartRequested || this.pendingConsentAllowed ? "continue" : "park";

        if (err instanceof AuthNeededError) {
          this.deps.logger.info("parking: auth needed", { reason: err.reason });
          this.setStatus(err.reason === "no_credentials" ? "awaiting_credentials" : "disconnected");
          this.emit("authRequired", err.reason);
          if (parkOrContinue() === "continue") continue;
          break; // park AWAITING_USER
        }
        if (err instanceof ConsentRequiredError) {
          this.deps.logger.info("parking: consent denied or timed out", { message: err.message });
          this.setStatus("disconnected", err.message);
          this.emit("authRequired", "consent_required");
          if (parkOrContinue() === "continue") continue;
          break; // park — no retry spam, no unprompted modal
        }
        if (err instanceof NoDiscordError) {
          this.setStatus("disconnected", "Discord is not running");
          await this.backoff(false);
          continue;
        }
        if (err instanceof RpcClosedError && !serverAccepted && err.kind === "rejected") {
          // Discord ANSWERED with a close/error frame — bad client id or similar.
          // (READY timeouts are NOT rejections: they're rate limiting or a wedged
          // pipe, and go down the generic retry path below.)
          this.handshakeRejections++;
          this.deps.logger.warn("handshake rejected by Discord", {
            message: err.message,
            count: this.handshakeRejections,
          });
          if (this.handshakeRejections >= 2) {
            this.setStatus("disconnected", `handshake rejected: ${err.message}`);
            this.emit("fatal", `Discord rejected the handshake (${err.message}). Check the Client ID.`);
            this.emit("authRequired", "token_invalid");
            if (parkOrContinue() === "continue") continue;
            break; // park
          }
          await this.backoff(true);
          continue;
        }
        if (err instanceof TokenEndpointError && err.kind === "network") {
          this.setStatus("disconnected", "Discord API unreachable");
          await this.backoff(serverAccepted);
          continue;
        }
        // Anything else (incl. READY timeouts and early pipe closes): log, retry with
        // class-(b) backoff whenever the server may have been touched.
        const touchedServer =
          serverAccepted || (err instanceof RpcClosedError && err.kind === "timeout");
        this.deps.logger.warn("session error; will retry", {
          message: String(err),
          touchedServer,
        });
        this.setStatus("disconnected", err instanceof Error ? err.message : String(err));
        await this.backoff(touchedServer);
        continue;
      }
    }

    this.running = false;
    this.client = null;
  }

  private makeClient(clientId: string): DiscordRpcClient {
    return (
      this.deps.clientFactory?.(clientId) ??
      new DiscordRpcClient({ clientId, logger: this.deps.logger })
    );
  }

  private waitForClose(client: DiscordRpcClient): Promise<void> {
    return new Promise((resolve) => {
      if (client.isClosed) {
        resolve();
        return;
      }
      client.once("close", () => resolve());
    });
  }

  private async backoff(serverWasAccepted: boolean): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const rand = this.deps.rand ?? Math.random;
    let delay = Math.min(BASE_BACKOFF_MS * 2 ** this.backoffExp, MAX_BACKOFF_MS);
    delay += delay * 0.2 * rand(); // jitter UPWARD only — never dips under the cap floor
    this.backoffExp = Math.min(this.backoffExp + 1, 6);
    if (serverWasAccepted) {
      const sinceServer = now() - this.lastServerConnectAt;
      delay = Math.max(delay, MIN_SERVER_ATTEMPT_GAP_MS - sinceServer);
    }
    await this.sleep(delay);
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleepFn) return this.deps.sleepFn(ms);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSleep = null;
        resolve();
      }, ms);
      this.wakeSleep = () => {
        clearTimeout(timer);
        this.wakeSleep = null;
        resolve();
      };
    });
  }

  // ---- dispatch + bootstrap ----

  /** Serializes channel-switch handling — two rapid VOICE_CHANNEL_SELECTs must not
   * interleave their unsubscribe/bootstrap wire traffic (observed live: UNSUB/SUB
   * interleaving when leaving+joining quickly). */
  private channelSwitchChain: Promise<void> = Promise.resolve();

  private wireDispatch(client: DiscordRpcClient): void {
    client.on("dispatch", (evt: string, rawData: unknown) => {
      const data = (rawData ?? {}) as Record<string, unknown>;
      if (evt === "VOICE_CHANNEL_SELECT") {
        const channelId = (data["channel_id"] as string | null) ?? null;
        this.channelSwitchChain = this.channelSwitchChain.then(() =>
          this.onChannelSelect(client, channelId).catch((err) =>
            this.deps.logger.warn("channel switch failed", { message: String(err) }),
          ),
        );
        return;
      }
      if ((CHANNEL_EVENTS as readonly string[]).includes(evt)) {
        if (this.bootstrapBuffer !== null) {
          this.bootstrapBuffer.push({ evt, data });
          return;
        }
        this.applyChannelEvent(evt, data);
      }
    });
  }

  private applyChannelEvent(evt: string, data: Record<string, unknown>): void {
    const tracker = this.deps.tracker;
    switch (evt) {
      case "VOICE_STATE_CREATE":
      case "VOICE_STATE_UPDATE":
        tracker.upsertMember(data as RawVoiceState);
        break;
      case "VOICE_STATE_DELETE": {
        const userId = (data as RawVoiceState).user?.id;
        if (userId) tracker.removeMember(userId);
        break;
      }
      case "SPEAKING_START": {
        const userId = data["user_id"];
        if (typeof userId === "string") tracker.speakingStart(userId);
        break;
      }
      case "SPEAKING_STOP": {
        const userId = data["user_id"];
        if (typeof userId === "string") tracker.speakingStop(userId);
        break;
      }
    }
  }

  private async postAuthBootstrap(client: DiscordRpcClient): Promise<void> {
    // 1. Global channel-switch subscription FIRST — a switch during bootstrap must not be missed.
    await client.subscribe("VOICE_CHANNEL_SELECT");

    // 2. Which channel are we in? (Take ONLY the id — the authoritative roster comes later.)
    this.setStatus("connecting", "fetching voice channel");
    const selected = (await client.sendCommand("GET_SELECTED_VOICE_CHANNEL")) as {
      id?: string;
    } | null;

    const channelId = selected?.id ?? null;
    if (!channelId) {
      this.currentChannelId = null;
      this.setChannel({ channelId: null, guildId: null, channelName: null });
      this.setStatus("no_channel");
      return;
    }
    await this.bootstrapChannel(client, channelId);
  }

  private async onChannelSelect(client: DiscordRpcClient, channelId: string | null): Promise<void> {
    this.generation++; // invalidate any in-flight bootstrap immediately
    const oldChannelId = this.currentChannelId;
    this.currentChannelId = null;
    this.deps.tracker.clear();

    if (oldChannelId) {
      for (const evt of CHANNEL_EVENTS) {
        // Discord errors when unsubscribing a channel you've left — not fatal.
        await client.unsubscribe(evt, { channel_id: oldChannelId }).catch(() => undefined);
      }
    }

    if (!channelId) {
      this.setChannel({ channelId: null, guildId: null, channelName: null });
      this.setStatus("no_channel");
      return;
    }
    await this.bootstrapChannel(client, channelId).catch((err) => {
      this.deps.logger.warn("channel bootstrap failed", { message: String(err) });
    });
  }

  /**
   * Race-safe bootstrap: SUBSCRIBE x5 -> buffer events -> GET_CHANNEL roster installed
   * LAST -> replay buffer. Abandons silently whenever a newer generation exists.
   */
  private async bootstrapChannel(client: DiscordRpcClient, channelId: string): Promise<void> {
    const gen = ++this.generation;
    const buffer: Array<{ evt: string; data: Record<string, unknown> }> = [];
    this.bootstrapBuffer = buffer;

    const stale = (): boolean => gen !== this.generation;
    const abandon = (): void => {
      if (this.bootstrapBuffer === buffer) this.bootstrapBuffer = null;
    };

    try {
      for (const evt of CHANNEL_EVENTS) {
        await client.subscribe(evt, { channel_id: channelId });
        if (stale()) return abandon();
      }

      const channel = (await client.sendCommand("GET_CHANNEL", { channel_id: channelId })) as {
        id?: string;
        name?: string;
        guild_id?: string | null;
        voice_states?: RawVoiceState[];
      };
      if (stale()) return abandon();

      this.currentChannelId = channelId;
      this.deps.tracker.setRoster(channel?.voice_states ?? []);

      // Replay everything that arrived during the window, in order.
      this.bootstrapBuffer = null;
      for (const { evt, data } of buffer) this.applyChannelEvent(evt, data);

      this.setChannel({
        channelId,
        guildId: (channel?.guild_id as string | null) ?? null,
        channelName: channel?.name ?? null,
      });
      this.setStatus("subscribed", channel?.name ? `#${channel.name}` : undefined);
    } catch (err) {
      abandon();
      throw err;
    }
  }

  // ---- event emission ----

  private setStatus(s: DiscordStatus, detail?: string): void {
    if (s !== this.lastStatus || detail !== this.lastDetail) {
      // Every transition is logged — silent failure paths made live debugging blind.
      this.deps.logger.info("status", { discord: s, ...(detail !== undefined && { detail }) });
    }
    this.lastStatus = s;
    this.lastDetail = detail;
    this.emit("status", s, detail);
  }

  private setChannel(info: ChannelInfo): void {
    this.channelInfo = info;
    this.emit("channel", info);
  }
}
