/**
 * Reconnecting WS client to the helper + the SpeakerStore the actions render from.
 *
 * Hello-gate: NOTHING is sent (especially setCredentials with the client secret)
 * until a valid `hello` with a matching protocolVersion arrives. A socket that
 * connects but sends no hello within 3 s is a foreign process squatting the port.
 *
 * Reconnect: 500 ms -> x2 -> cap 5 s, forever. After 3 consecutive failures the
 * manager is asked to respawn the helper (event "helperUnreachable").
 */
import { EventEmitter } from "node:events";
import {
  DEFAULT_HELPER_PORT,
  PROTOCOL_VERSION,
  parseHelperMessage,
  type DiscordStatus,
  type HelloMessage,
  type MemberInfo,
  type PluginToHelperMessage,
} from "@dsd/shared";
import WebSocket from "ws";

const HELLO_TIMEOUT_MS = 3_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 5_000;
const UNREACHABLE_AFTER_FAILURES = 3;

export type HelperLink = "connecting" | "connected" | "down" | "port_conflict";

export interface SpeakerStoreState {
  helper: HelperLink;
  hello: HelloMessage | null;
  status: DiscordStatus;
  statusDetail?: string;
  channelName: string | null;
  members: MemberInfo[];
  speaker: MemberInfo | null;
  speakingCount: number;
  authRequired: "no_credentials" | "consent_required" | "token_invalid" | null;
  fatalError: string | null;
}

function initialState(): SpeakerStoreState {
  return {
    helper: "connecting",
    hello: null,
    status: "disconnected",
    channelName: null,
    members: [],
    speaker: null,
    speakingCount: 0,
    authRequired: null,
    fatalError: null,
  };
}

/** Latest-value-wins state. Actions repaint from this on every "changed". */
export class SpeakerStore extends EventEmitter {
  state: SpeakerStoreState = initialState();

  patch(p: Partial<SpeakerStoreState>): void {
    this.state = { ...this.state, ...p };
    this.emit("changed", this.state);
  }
}

export interface HelperClientOptions {
  store: SpeakerStore;
  port?: number;
  logger: { debug(m: string): void; info(m: string): void; warn(m: string): void };
}

/**
 * Events:
 * - "connected" (hello: HelloMessage)  — hello-gate passed; safe to send
 * - "helperUnreachable" ()             — 3 consecutive connect failures; manager should respawn
 */
export class HelperClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private gated = false; // true after valid hello
  private failures = 0;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HelperClientOptions) {
    super();
  }

  get port(): number {
    return this.opts.port ?? DEFAULT_HELPER_PORT;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
    this.ws = null;
  }

  /** Hello-gated send. Returns false (and drops) when the gate is closed. */
  send(msg: PluginToHelperMessage): boolean {
    if (!this.gated || this.ws?.readyState !== WebSocket.OPEN) {
      this.opts.logger.warn(`dropped ${msg.type}: helper link not established`);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    this.gated = false;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;

    const helloTimer = setTimeout(() => {
      // Connected but silent: a foreign process owns the port.
      this.opts.logger.warn(`no hello within ${HELLO_TIMEOUT_MS} ms — foreign process on port ${this.port}?`);
      this.opts.store.patch({ helper: "port_conflict" });
      ws.terminate();
    }, HELLO_TIMEOUT_MS);

    ws.on("open", () => this.opts.logger.debug("ws open; awaiting hello"));

    ws.on("message", (raw) => {
      const msg = parseHelperMessage(raw.toString());
      if (!msg) return;

      if (msg.type === "hello") {
        clearTimeout(helloTimer);
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          // Treated exactly like a buildId mismatch: the manager swaps the helper.
          this.opts.logger.warn(
            `helper protocol ${msg.protocolVersion} != ${PROTOCOL_VERSION}; requesting swap`,
          );
          this.gated = true; // allow the shutdown message through
          this.opts.store.patch({ hello: msg, helper: "connected" });
          this.emit("connected", msg);
          return;
        }
        this.gated = true;
        this.failures = 0;
        this.opts.store.patch({ hello: msg, helper: "connected" });
        this.emit("connected", msg);
        return;
      }

      if (!this.gated) return; // ignore everything else pre-hello

      switch (msg.type) {
        case "status":
          this.opts.store.patch({
            status: msg.discord,
            statusDetail: msg.detail,
            // Progress clears a stale authRequired flag.
            ...(msg.discord === "subscribed" || msg.discord === "authenticating"
              ? { authRequired: null, fatalError: null }
              : {}),
          });
          break;
        case "channel":
          this.opts.store.patch({ channelName: msg.channelName, members: msg.members });
          break;
        case "speaker":
          this.opts.store.patch({ speaker: msg.speaker, speakingCount: msg.speakingCount });
          break;
        case "authRequired":
          this.opts.store.patch({ authRequired: msg.reason });
          break;
        case "error":
          this.opts.logger.warn(`helper error: ${msg.code} ${msg.message}`);
          if (!msg.recoverable) this.opts.store.patch({ fatalError: msg.message });
          break;
      }
    });

    const onGone = (): void => {
      clearTimeout(helloTimer);
      if (this.ws !== ws) return; // superseded
      this.ws = null;
      this.gated = false;
      if (this.stopped) return;
      this.failures++;
      if (this.opts.store.state.helper !== "port_conflict") {
        this.opts.store.patch({ helper: this.failures >= UNREACHABLE_AFTER_FAILURES ? "down" : "connecting" });
      }
      if (this.failures === UNREACHABLE_AFTER_FAILURES) {
        this.emit("helperUnreachable");
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(this.failures, 4), RECONNECT_CAP_MS);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    ws.on("close", onGone);
    ws.on("error", (err) => {
      this.opts.logger.debug(`ws error: ${err.message}`);
      ws.terminate();
    });
  }
}
