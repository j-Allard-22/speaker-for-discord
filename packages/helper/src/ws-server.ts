/**
 * Localhost WS server for the plugin.
 *
 * - Port binding IS the single-instance lock. On EADDRINUSE we retry for ~5 s
 *   (250 ms interval) before concluding a healthy incumbent owns the port and
 *   exiting 0 — a just-shutdown predecessor frees the port within that window
 *   (fixes the upgrade respawn race).
 * - Snapshot-on-connect: every new client gets hello -> status -> channel -> speaker.
 * - Heartbeat: WE ping each client every 15 s (isAlive/pong pattern) and terminate
 *   after 2 missed rounds. The plugin needs no ping of its own.
 */
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import {
  PROTOCOL_VERSION,
  parsePluginMessage,
  type HelperToPluginMessage,
  type PluginToHelperMessage,
} from "@dsd/shared";
import { WebSocket, WebSocketServer } from "ws";
import type { HelperLogger } from "./logger.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const BIND_RETRY_WINDOW_MS = 5_000;
const BIND_RETRY_INTERVAL_MS = 250;

interface TrackedClient extends WebSocket {
  isAlive?: boolean;
  missedPongs?: number;
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
  /** Returns the current snapshot messages (status, channel, speaker) in send order. */
  snapshot: () => HelperToPluginMessage[];
}

/**
 * Events:
 * - "message" (msg: PluginToHelperMessage, reply: (m: HelperToPluginMessage) => void)
 * - "clientsChanged" (count: number)
 */
export class HelperServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  lastClientSeenAt: number = Date.now();

  constructor(private readonly opts: HelperServerOptions) {
    super();
  }

  get clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  /** Bind with retry window; rejects PortOwnedError if an incumbent keeps the port. */
  async start(): Promise<number> {
    const deadline = Date.now() + BIND_RETRY_WINDOW_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
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

  broadcast(msg: HelperToPluginMessage): void {
    const raw = JSON.stringify(msg);
    for (const client of this.wss?.clients ?? []) {
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    this.wss = null;
  }

  // ---- internals ----

  private tryBind(): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: this.opts.port });
      const onError = (err: Error): void => {
        wss.close();
        reject(err);
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.removeListener("error", onError);
        // Post-bind errors shouldn't crash the helper.
        wss.on("error", (err) => this.opts.logger.error("ws server error", { message: err.message }));
        resolve(wss);
      });
    });
  }

  private onConnection(ws: TrackedClient): void {
    this.lastClientSeenAt = Date.now();
    ws.isAlive = true;
    ws.missedPongs = 0;
    ws.on("pong", () => {
      ws.isAlive = true;
      ws.missedPongs = 0;
      this.lastClientSeenAt = Date.now();
    });

    // Snapshot-on-connect (this is what makes willAppear-after-restart irrelevant):
    const hello: HelperToPluginMessage = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      helperVersion: this.opts.helperVersion,
      buildId: this.opts.buildId,
      pid: process.pid,
    };
    ws.send(JSON.stringify(hello));
    for (const msg of this.opts.snapshot()) ws.send(JSON.stringify(msg));

    ws.on("message", (raw) => {
      this.lastClientSeenAt = Date.now();
      const msg: PluginToHelperMessage | null = parsePluginMessage(raw.toString());
      if (!msg) {
        this.opts.logger.warn("unparseable client message dropped");
        return;
      }
      this.emit("message", msg, (reply: HelperToPluginMessage) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
      });
    });

    ws.on("close", () => {
      this.lastClientSeenAt = Date.now();
      this.emit("clientsChanged", this.clientCount);
    });

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
