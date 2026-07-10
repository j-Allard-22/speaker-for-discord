/**
 * Localhost WS server for the plugin.
 *
 * THREAT MODEL: 127.0.0.1 is reachable by any web page the user visits (browsers open
 * ws:// cross-origin with no CORS preflight) and by any local process, including one
 * running as a different non-admin user. Therefore:
 *
 *  - Nothing is disclosed before the peer proves it holds the session key. `hello`
 *    carries only a nonce and the protocol version — not even the helper's pid.
 *  - The server proves possession FIRST (bound to the client's fresh nonce), so a
 *    port-squatter can never coax the plugin into sending Discord credentials.
 *  - `Origin` is rejected at the upgrade: browsers always send it, the `ws` client
 *    never does. Necessary but NOT sufficient (a native process sends none) — the
 *    HMAC handshake is the load-bearing control.
 *  - maxPayload, a client cap, and an unauthenticated-socket timeout bound the DoS.
 *
 * Port binding IS the single-instance lock. On EADDRINUSE we retry for ~5 s so a
 * just-shutdown predecessor can free the port (fixes the upgrade respawn race).
 */
import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import {
  HANDSHAKE_TIMEOUT_MS,
  MAX_CLIENTS,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  isValidNonce,
  parseHandshakeClientMessage,
  parsePluginMessage,
  sessionNonce,
  sessionProof,
  verifySessionProof,
  type HelloMessage,
  type HelperToPluginMessage,
  type PluginToHelperMessage,
  type ServerAuthMessage,
  type WelcomeMessage,
} from "@dsd/shared";
import { WebSocket, WebSocketServer } from "ws";
import type { HelperLogger } from "./logger.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const BIND_RETRY_WINDOW_MS = 5_000;
const BIND_RETRY_INTERVAL_MS = 250;

interface TrackedClient extends WebSocket {
  isAlive?: boolean;
  missedPongs?: number;
  /** Set only after the client's proof verifies. Ungated sockets receive nothing. */
  authed?: boolean;
  serverNonce?: string;
  clientNonce?: string;
  handshakeTimer?: NodeJS.Timeout;
}

export class PortOwnedError extends Error {
  constructor(port: number) {
    super(`port ${port} is owned by another (healthy) helper instance`);
    this.name = "PortOwnedError";
  }
}

export interface HelperServerOptions {
  port: number;
  helperVersion: string;
  buildId: string;
  logger: HelperLogger;
  /** Shared per-machine secret; see @dsd/shared session-key.ts. */
  sessionKey: Buffer;
  /** Current snapshot messages (status, channel, speaker, [authRequired]) in send order. */
  snapshot: () => HelperToPluginMessage[];
}

/** Browsers always send Origin on a WS upgrade; our `ws` client never does. */
function rejectsUpgrade(req: IncomingMessage, port: number): boolean {
  if (req.headers.origin !== undefined) return true;
  const host = req.headers.host;
  if (host === undefined) return false;
  return host !== `127.0.0.1:${port}` && host !== `localhost:${port}`;
}

/**
 * Events:
 * - "message" (msg: PluginToHelperMessage, reply: (m: HelperToPluginMessage) => void)
 *   — emitted ONLY for authenticated clients.
 * - "clientsChanged" (count: number)
 */
export class HelperServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  lastClientSeenAt: number = Date.now();

  constructor(private readonly opts: HelperServerOptions) {
    super();
  }

  /** Sockets that completed the handshake. Orphan-watch counts only these. */
  get clientCount(): number {
    let n = 0;
    for (const c of (this.wss?.clients ?? []) as Set<TrackedClient>) if (c.authed) n++;
    return n;
  }

  async start(): Promise<number> {
    const deadline = Date.now() + BIND_RETRY_WINDOW_MS;
    for (;;) {
      try {
        this.wss = await this.tryBind();
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" || Date.now() >= deadline) {
          if (code === "EADDRINUSE") throw new PortOwnedError(this.opts.port);
          throw err;
        }
        await new Promise((r) => setTimeout(r, BIND_RETRY_INTERVAL_MS));
      }
    }

    this.wss.on("connection", (ws: TrackedClient) => this.onConnection(ws));
    this.heartbeat = setInterval(() => this.pingRound(), HEARTBEAT_INTERVAL_MS);
    const port = (this.wss.address() as AddressInfo).port;
    this.opts.logger.info("ws server listening", { port });
    return port;
  }

  /** Broadcast reaches AUTHENTICATED clients only — a mid-handshake socket gets nothing. */
  broadcast(msg: HelperToPluginMessage): void {
    const raw = JSON.stringify(msg);
    for (const client of (this.wss?.clients ?? []) as Set<TrackedClient>) {
      if (client.authed && client.readyState === WebSocket.OPEN) client.send(raw);
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of (this.wss?.clients ?? []) as Set<TrackedClient>) {
      if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
      client.terminate();
    }
    this.wss?.close();
    this.wss = null;
  }

  // ---- internals ----

  private tryBind(): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.opts.port,
        maxPayload: MAX_PAYLOAD_BYTES,
        verifyClient: (info: { req: IncomingMessage }) => !rejectsUpgrade(info.req, this.opts.port),
      });
      const onError = (err: Error): void => {
        wss.close();
        reject(err);
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.removeListener("error", onError);
        wss.on("error", (err) => this.opts.logger.error("ws server error", { message: err.message }));
        resolve(wss);
      });
    });
  }

  private onConnection(ws: TrackedClient): void {
    // A socket-level protocol error (oversized frame, malformed masking) emits "error".
    // Without this listener Node turns it into an uncaughtException and the helper
    // exits(1) — i.e. any peer could crash it by sending one > maxPayload frame. This
    // MUST be attached before any early return: a socket refused by the client cap can
    // still be mid-CLOSING when its oversized frame lands, so it needs the listener too.
    ws.on("error", (err) => {
      this.opts.logger.warn("client socket error; terminating", { message: err.message });
      ws.terminate();
    });

    if ((this.wss?.clients.size ?? 0) > MAX_CLIENTS) {
      this.opts.logger.warn("client cap reached; refusing connection");
      ws.close(1013, "too many clients");
      return;
    }

    ws.isAlive = true;
    ws.missedPongs = 0;
    ws.authed = false;
    ws.serverNonce = sessionNonce();

    ws.on("pong", () => {
      ws.isAlive = true;
      ws.missedPongs = 0;
      if (ws.authed) this.lastClientSeenAt = Date.now();
    });

    // A peer that never completes the handshake is dropped — no lingering listeners.
    ws.handshakeTimer = setTimeout(() => {
      if (!ws.authed) {
        this.opts.logger.warn("handshake timeout; terminating peer");
        ws.terminate();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const hello: HelloMessage = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverNonce: ws.serverNonce,
    };
    ws.send(JSON.stringify(hello));

    ws.on("message", (raw) => this.onMessage(ws, raw.toString()));

    ws.on("close", () => {
      if (ws.handshakeTimer) clearTimeout(ws.handshakeTimer);
      if (ws.authed) {
        this.lastClientSeenAt = Date.now();
        this.emit("clientsChanged", this.clientCount);
      }
    });
  }

  private onMessage(ws: TrackedClient, raw: string): void {
    if (!ws.authed) {
      this.onHandshakeMessage(ws, raw);
      return;
    }
    this.lastClientSeenAt = Date.now();
    const msg: PluginToHelperMessage | null = parsePluginMessage(raw);
    if (!msg) {
      this.opts.logger.warn("unparseable client message dropped");
      return;
    }
    this.emit("message", msg, (reply: HelperToPluginMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
    });
  }

  /** Pre-auth frames go through the NARROW parser — no app message can slip in here. */
  private onHandshakeMessage(ws: TrackedClient, raw: string): void {
    const msg = parseHandshakeClientMessage(raw);
    if (!msg) {
      this.opts.logger.warn("bad handshake frame; terminating peer");
      ws.terminate();
      return;
    }

    if (msg.type === "clientChallenge") {
      if (ws.clientNonce !== undefined || !isValidNonce(msg.clientNonce)) {
        ws.terminate();
        return;
      }
      ws.clientNonce = msg.clientNonce;
      const serverAuth: ServerAuthMessage = {
        type: "serverAuth",
        serverProof: sessionProof(this.opts.sessionKey, "S", ws.serverNonce!, ws.clientNonce),
      };
      ws.send(JSON.stringify(serverAuth));
      return;
    }

    // clientAuth
    if (ws.clientNonce === undefined) {
      ws.terminate(); // out of order
      return;
    }
    const ok = verifySessionProof(
      this.opts.sessionKey,
      "C",
      ws.serverNonce!,
      ws.clientNonce,
      msg.clientProof,
    );
    if (!ok) {
      this.opts.logger.warn("client failed authentication; terminating peer");
      ws.terminate();
      return;
    }

    if (ws.handshakeTimer) clearTimeout(ws.handshakeTimer);
    ws.authed = true;
    this.lastClientSeenAt = Date.now();
    this.opts.logger.info("client authenticated");

    const welcome: WelcomeMessage = {
      type: "welcome",
      helperVersion: this.opts.helperVersion,
      buildId: this.opts.buildId,
      pid: process.pid,
    };
    ws.send(JSON.stringify(welcome));
    for (const m of this.opts.snapshot()) ws.send(JSON.stringify(m));
    this.emit("clientsChanged", this.clientCount);
  }

  private pingRound(): void {
    for (const client of (this.wss?.clients ?? []) as Set<TrackedClient>) {
      if (client.isAlive === false) {
        client.missedPongs = (client.missedPongs ?? 0) + 1;
        if (client.missedPongs >= 2) {
          this.opts.logger.warn("terminating unresponsive client");
          client.terminate();
          continue;
        }
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        /* terminated concurrently */
      }
    }
  }
}
