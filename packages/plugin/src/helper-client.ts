/**
 * Reconnecting WS client to the helper + the SpeakerStore the actions render from.
 *
 * MUTUAL AUTH (see @dsd/shared session-key.ts). The plugin verifies the SERVER's proof
 * before sending anything at all — so a process squatting the helper's port can never
 * coax it into disclosing the user's Discord credentials. It then proves possession in
 * turn, and only afterwards does the helper release any Discord state.
 *
 *   S->C hello{serverNonce}  C->S clientChallenge{clientNonce}
 *   S->C serverAuth{proof}   [verify or terminate]   C->S clientAuth{proof}
 *   S->C welcome{...}        -> gate open
 *
 * Reconnect: 500 ms -> x2 -> cap 5 s, forever. After 3 consecutive failures the manager
 * is asked to respawn the helper (event "helperUnreachable").
 */
import { EventEmitter } from "node:events";
import {
  DEFAULT_HELPER_PORT,
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseHandshakeServerMessage,
  parseHelperMessage,
  sessionNonce,
  sessionProof,
  verifySessionProof,
  type ClientAuthMessage,
  type ClientChallengeMessage,
  type DiscordStatus,
  type MemberInfo,
  type PluginToHelperMessage,
} from "@dsd/shared";
import WebSocket from "ws";

const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 5_000;
const UNREACHABLE_AFTER_FAILURES = 3;

export type HelperLink = "connecting" | "connected" | "down" | "port_conflict";

/** Identity of the authenticated helper — only trustworthy post-handshake. */
export interface HelperIdentity {
  helperVersion: string;
  buildId: string;
  pid: number;
}

export interface SpeakerStoreState {
  helper: HelperLink;
  identity: HelperIdentity | null;
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
    identity: null,
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
  sessionKey: Buffer;
  port?: number;
  logger: { debug(m: string): void; info(m: string): void; warn(m: string): void };
}

/**
 * Events:
 * - "connected" (identity: HelperIdentity)  — mutual auth passed; safe to send
 * - "helperUnreachable" ()                  — 3 consecutive failures; manager should respawn
 */
export class HelperClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private authed = false;
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

  /** Auth-gated send. Returns false (and drops) until mutual auth has completed. */
  send(msg: PluginToHelperMessage): boolean {
    if (!this.authed || this.ws?.readyState !== WebSocket.OPEN) {
      this.opts.logger.warn(`dropped ${msg.type}: helper link not authenticated`);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    this.authed = false;

    // `ws` sends no Origin header unless asked — the helper rejects any upgrade that
    // carries one, which is what keeps browsers out.
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;

    /** Handshake progress: which frame we expect next. */
    let phase: "hello" | "serverAuth" | "welcome" | "open" = "hello";
    let serverNonce = "";
    const clientNonce = sessionNonce();

    const handshakeTimer = setTimeout(() => {
      this.opts.logger.warn(
        `handshake did not complete in ${HANDSHAKE_TIMEOUT_MS} ms — foreign process on port ${this.port}?`,
      );
      this.opts.store.patch({ helper: "port_conflict" });
      ws.terminate();
    }, HANDSHAKE_TIMEOUT_MS);

    /** Anything unexpected before the gate opens: say nothing, drop the socket. */
    const refuse = (why: string, link: HelperLink = "port_conflict"): void => {
      this.opts.logger.warn(why);
      this.opts.store.patch({ helper: link });
      ws.terminate();
    };

    ws.on("open", () => this.opts.logger.debug("ws open; awaiting hello"));

    ws.on("message", (raw) => {
      const text = raw.toString();

      if (phase === "hello") {
        const hs = parseHandshakeServerMessage(text);
        if (hs?.type !== "hello") return refuse("expected hello; terminating");
        if (hs.protocolVersion !== PROTOCOL_VERSION) {
          // A stale helper can neither be trusted nor authenticated. Refuse it: with no
          // clients it idle-exits, then the manager spawns the current build.
          return refuse(
            `helper protocol ${hs.protocolVersion} != ${PROTOCOL_VERSION}; refusing (it will idle-exit)`,
            "down",
          );
        }
        serverNonce = hs.serverNonce;
        const challenge: ClientChallengeMessage = { type: "clientChallenge", clientNonce };
        ws.send(JSON.stringify(challenge));
        phase = "serverAuth";
        return;
      }

      if (phase === "serverAuth") {
        const hs = parseHandshakeServerMessage(text);
        if (hs?.type !== "serverAuth") return refuse("expected serverAuth; terminating");
        // THE moment that defeats a port-squatter: we send nothing — not our proof, and
        // certainly not setCredentials — unless the peer proves it holds the session key.
        const ok = verifySessionProof(this.opts.sessionKey, "S", serverNonce, clientNonce, hs.serverProof);
        if (!ok) {
          return refuse(`peer on port ${this.port} failed authentication — NOT the helper`);
        }
        const clientAuth: ClientAuthMessage = {
          type: "clientAuth",
          clientProof: sessionProof(this.opts.sessionKey, "C", serverNonce, clientNonce),
        };
        ws.send(JSON.stringify(clientAuth));
        phase = "welcome";
        return;
      }

      if (phase === "welcome") {
        const msg = parseHelperMessage(text);
        if (msg?.type !== "welcome") return refuse("expected welcome; terminating");
        clearTimeout(handshakeTimer);
        phase = "open";
        this.authed = true;
        this.failures = 0;
        const identity: HelperIdentity = {
          helperVersion: msg.helperVersion,
          buildId: msg.buildId,
          pid: msg.pid,
        };
        this.opts.logger.info(`helper authenticated (pid ${identity.pid}, build ${identity.buildId})`);
        this.opts.store.patch({ identity, helper: "connected" });
        this.emit("connected", identity);
        return;
      }

      // ---- authenticated ----
      const msg = parseHelperMessage(text);
      if (!msg) return;

      switch (msg.type) {
        case "welcome":
          break; // a second welcome is meaningless; ignore
        case "status":
          this.opts.store.patch({
            status: msg.discord,
            statusDetail: msg.detail,
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
      clearTimeout(handshakeTimer);
      if (this.ws !== ws) return; // superseded
      this.ws = null;
      this.authed = false;
      if (this.stopped) return;
      this.failures++;
      if (this.opts.store.state.helper !== "port_conflict") {
        this.opts.store.patch({
          helper: this.failures >= UNREACHABLE_AFTER_FAILURES ? "down" : "connecting",
        });
      }
      if (this.failures === UNREACHABLE_AFTER_FAILURES) this.emit("helperUnreachable");
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
