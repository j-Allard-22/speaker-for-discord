/**
 * Discord local RPC transport: named pipe + binary framing.
 *
 * Wire format (both directions): 8-byte little-endian header — u32 opcode,
 * u32 payload length — followed by `length` bytes of UTF-8 JSON.
 *
 * Windows pipes: \\?\pipe\discord-ipc-0 through -9 (first client instance owns -0).
 */
import { EventEmitter } from "node:events";
import * as net from "node:net";

export const Opcode = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
} as const;
export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode];

/** DoS guard: disconnect (without allocating) on any frame claiming more than this. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class NoDiscordError extends Error {
  constructor() {
    super("Discord IPC pipe not found (is the Discord desktop app running?)");
    this.name = "NoDiscordError";
  }
}

export function encodeFrame(op: OpcodeValue, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeUInt32LE(op, 0);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

/**
 * Incremental frame parser. Feed raw socket chunks with push(); emits:
 * - "frame" (op: number, payload: unknown)  — payload already JSON-parsed (NOT normalized)
 * - "error" (err: Error)                    — oversized or malformed frame; caller must disconnect
 */
export class FrameParser extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private dead = false;

  push(chunk: Buffer): void {
    if (this.dead) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (len > MAX_FRAME_BYTES) {
        this.fail(new Error(`frame declares ${len} bytes (cap ${MAX_FRAME_BYTES})`));
        return;
      }
      if (this.buf.length < 8 + len) return; // wait for more data
      const body = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        this.fail(new Error("frame body is not valid JSON"));
        return;
      }
      this.emit("frame", op, payload);
    }
  }

  private fail(err: Error): void {
    this.dead = true;
    this.buf = Buffer.alloc(0);
    this.emit("error", err);
  }
}

export function defaultPipePaths(): string[] {
  const paths: string[] = [];
  for (let i = 0; i <= 9; i++) paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
  return paths;
}

/**
 * Try each pipe path in order; resolve the first that connects.
 * Rejects NoDiscordError when all refuse (Discord not running).
 */
export function discoverPipe(paths: string[] = defaultPipePaths()): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const tryAt = (i: number): void => {
      if (i >= paths.length) {
        reject(new NoDiscordError());
        return;
      }
      const socket = net.connect(paths[i]!);
      const onError = (): void => {
        socket.destroy();
        tryAt(i + 1);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        resolve(socket);
      });
    };
    tryAt(0);
  });
}
