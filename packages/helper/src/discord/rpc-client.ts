/**
 * Low-level Discord RPC client: one pipe connection, handshake, command/response
 * plumbing, dispatch events. No auth or subscription logic here (see auth.ts and
 * session.ts) — this layer is unit-testable against a mock socket.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type * as net from "node:net";
import type { HelperLogger } from "../logger.js";
import { discoverPipe, encodeFrame, FrameParser, Opcode } from "./ipc-transport.js";
import { normalizeKeys } from "./normalize.js";

/** Server rejected the HANDSHAKE (bad client_id, protocol error) or closed with an error. */
export class RpcClosedError extends Error {
  /**
   * - "rejected": Discord answered with a CLOSE frame (bad client id, protocol error) —
   *   retrying won't help; the session parks after repeats.
   * - "timeout": no READY within the window (rate limiting, wedged pipe) — retryable
   *   with the rate-limit-safe backoff.
   * - "closed": the pipe died (Discord quit, we closed it) — normal reconnect path.
   */
  constructor(
    message: string,
    readonly code?: number,
    readonly kind: "rejected" | "timeout" | "closed" = "closed",
  ) {
    super(message);
    this.name = "RpcClosedError";
  }
}

/** A command response with evt:"ERROR". */
export class RpcCommandError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "RpcCommandError";
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DiscordRpcClientOptions {
  clientId: string;
  logger?: HelperLogger;
  /** Injectable for tests. */
  discover?: () => Promise<net.Socket>;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export interface ReadyData {
  v?: number;
  user?: { id?: string; username?: string };
  [k: string]: unknown;
}

/**
 * Events:
 * - "dispatch" (evt: string, data: unknown) — normalized payloads
 * - "close" (err: Error | null)            — pipe gone; client is dead, make a new one
 */
export class DiscordRpcClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly opts: DiscordRpcClientOptions) {
    super();
  }

  /** Connect, handshake, resolve on READY. Rejects NoDiscordError / RpcClosedError. */
  async connect(): Promise<ReadyData> {
    const discover = this.opts.discover ?? discoverPipe;
    const socket = await discover();
    this.socket = socket;

    const parser = new FrameParser();
    socket.on("data", (chunk: Buffer) => parser.push(chunk));
    parser.on("error", (err: Error) => {
      this.opts.logger?.warn("ipc frame error; disconnecting", { message: err.message });
      this.teardown(err);
    });
    socket.on("error", (err: Error) => this.teardown(err));
    socket.on("close", () => this.teardown(null));

    return await new Promise<ReadyData>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new RpcClosedError("timed out waiting for READY", undefined, "timeout");
        cleanup();
        this.teardown(err);
        reject(err);
      }, this.opts.readyTimeoutMs ?? 10_000);

      // Socket death during the handshake must fail FAST with the real cause —
      // never dangle until the READY timer fires with a misleading "timed out".
      const onEarlyClose = (err: Error | null): void => {
        cleanup();
        reject(err ?? new RpcClosedError("connection closed during handshake", undefined, "closed"));
      };

      const onFrame = (op: number, rawPayload: unknown): void => {
        let payload: Record<string, unknown>;
        try {
          payload = normalizeKeys(rawPayload) as Record<string, unknown>;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          cleanup();
          this.teardown(e);
          reject(e);
          return;
        }
        if (op === Opcode.PING) {
          this.send(Opcode.PONG, payload);
          return;
        }
        if (op === Opcode.CLOSE) {
          const message = String(payload?.["message"] ?? "server closed connection");
          const code = typeof payload?.["code"] === "number" ? (payload["code"] as number) : undefined;
          cleanup();
          const err = new RpcClosedError(message, code, "rejected");
          this.teardown(err);
          reject(err);
          return;
        }
        if (op === Opcode.FRAME && payload?.["cmd"] === "DISPATCH" && payload?.["evt"] === "READY") {
          cleanup();
          parser.on("frame", (o: number, p: unknown) => this.onFrame(o, p));
          resolve((payload["data"] ?? {}) as ReadyData);
          return;
        }
        // Anything else before READY is unexpected but non-fatal; log and wait.
        this.opts.logger?.debug("pre-READY frame ignored", { op, payload });
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        parser.removeListener("frame", onFrame);
        this.removeListener("close", onEarlyClose);
      };

      this.once("close", onEarlyClose);
      parser.on("frame", onFrame);
      this.send(Opcode.HANDSHAKE, { v: 1, client_id: this.opts.clientId });
    });
  }

  /**
   * Send a command and await its nonce-matched response.
   *
   * CRITICAL wire detail: SUBSCRIBE/UNSUBSCRIBE carry the event name in the TOP-LEVEL
   * `evt` field of the envelope — NOT inside args. Pass it as the `evt` parameter.
   */
  sendCommand(cmd: string, args?: Record<string, unknown>, evt?: string): Promise<unknown> {
    if (this.closed || !this.socket) {
      return Promise.reject(new RpcClosedError("client is closed"));
    }
    const nonce = randomUUID();
    const envelope: Record<string, unknown> = { cmd, args: args ?? {}, nonce };
    if (evt !== undefined) envelope["evt"] = evt;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new RpcCommandError(`${cmd} timed out`));
      }, this.opts.commandTimeoutMs ?? 10_000);
      this.pending.set(nonce, { resolve, reject, timer });
      this.opts.logger?.debug("rpc send", envelope);
      this.send(Opcode.FRAME, envelope);
    });
  }

  subscribe(evt: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.sendCommand("SUBSCRIBE", args, evt);
  }

  unsubscribe(evt: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.sendCommand("UNSUBSCRIBE", args, evt);
  }

  close(): void {
    this.teardown(null);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---- internals ----

  private onFrame(op: number, rawPayload: unknown): void {
    let payload: Record<string, unknown>;
    try {
      payload = normalizeKeys(rawPayload) as Record<string, unknown>;
    } catch (err) {
      // A hostile/oversized payload structure — disconnect rather than crash.
      this.opts.logger?.warn("dropping malformed frame", { message: String(err) });
      this.teardown(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (op === Opcode.PING) {
      this.send(Opcode.PONG, payload);
      return;
    }
    if (op === Opcode.CLOSE) {
      const message = String(payload?.["message"] ?? "server closed connection");
      const code = typeof payload?.["code"] === "number" ? (payload["code"] as number) : undefined;
      this.teardown(new RpcClosedError(message, code));
      return;
    }
    if (op !== Opcode.FRAME) return;

    const nonce = payload?.["nonce"];
    if (typeof nonce === "string" && this.pending.has(nonce)) {
      const p = this.pending.get(nonce)!;
      this.pending.delete(nonce);
      clearTimeout(p.timer);
      if (payload["evt"] === "ERROR") {
        const data = (payload["data"] ?? {}) as Record<string, unknown>;
        p.reject(
          new RpcCommandError(
            String(data["message"] ?? "RPC error"),
            typeof data["code"] === "number" ? (data["code"] as number) : undefined,
          ),
        );
      } else {
        p.resolve(payload["data"]);
      }
      return;
    }

    if (payload?.["cmd"] === "DISPATCH" && typeof payload["evt"] === "string") {
      this.emit("dispatch", payload["evt"], payload["data"]);
    }
  }

  private send(op: number, payload: unknown): void {
    if (this.closed || !this.socket) return;
    this.socket.write(encodeFrame(op as 0 | 1 | 2 | 3 | 4, payload));
  }

  private teardown(err: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err ?? new RpcClosedError("connection closed"));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    this.emit("close", err);
  }
}
