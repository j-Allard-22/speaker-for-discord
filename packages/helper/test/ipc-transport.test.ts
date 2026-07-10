import { describe, expect, it, vi } from "vitest";
import {
  encodeFrame,
  FrameParser,
  MAX_FRAME_BYTES,
  Opcode,
} from "../src/discord/ipc-transport";

function collect(parser: FrameParser): Array<{ op: number; payload: unknown }> {
  const frames: Array<{ op: number; payload: unknown }> = [];
  parser.on("frame", (op: number, payload: unknown) => frames.push({ op, payload }));
  return frames;
}

describe("frame codec", () => {
  it("round-trips a frame", () => {
    const parser = new FrameParser();
    const frames = collect(parser);
    parser.push(encodeFrame(Opcode.HANDSHAKE, { v: 1, client_id: "123" }));
    expect(frames).toEqual([{ op: 0, payload: { v: 1, client_id: "123" } }]);
  });

  it("reassembles frames split across arbitrary chunk boundaries", () => {
    const whole = Buffer.concat([
      encodeFrame(Opcode.FRAME, { cmd: "DISPATCH", evt: "READY" }),
      encodeFrame(Opcode.PING, {}),
      encodeFrame(Opcode.FRAME, { cmd: "SUBSCRIBE", evt: "SPEAKING_START" }),
    ]);
    // Feed one byte at a time — worst case fragmentation.
    const parser = new FrameParser();
    const frames = collect(parser);
    for (const byte of whole) parser.push(Buffer.from([byte]));
    expect(frames).toHaveLength(3);
    expect(frames[0]!.payload).toEqual({ cmd: "DISPATCH", evt: "READY" });
    expect(frames[1]!.op).toBe(Opcode.PING);
    expect(frames[2]!.payload).toEqual({ cmd: "SUBSCRIBE", evt: "SPEAKING_START" });
  });

  it("handles multiple frames arriving in one chunk", () => {
    const parser = new FrameParser();
    const frames = collect(parser);
    parser.push(
      Buffer.concat([encodeFrame(Opcode.FRAME, { a: 1 }), encodeFrame(Opcode.FRAME, { b: 2 })]),
    );
    expect(frames.map((f) => f.payload)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("rejects oversized declared lengths without allocating", () => {
    const parser = new FrameParser();
    const onError = vi.fn();
    const frames = collect(parser);
    parser.on("error", onError);
    const evil = Buffer.allocUnsafe(8);
    evil.writeUInt32LE(Opcode.FRAME, 0);
    evil.writeUInt32LE(MAX_FRAME_BYTES + 1, 4);
    parser.push(evil);
    expect(onError).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(0);
    // Parser is dead after a protocol error — further pushes are ignored.
    parser.push(encodeFrame(Opcode.FRAME, { ok: true }));
    expect(frames).toHaveLength(0);
  });

  it("rejects non-JSON bodies", () => {
    const parser = new FrameParser();
    const onError = vi.fn();
    parser.on("error", onError);
    const body = Buffer.from("not json{", "utf8");
    const frame = Buffer.allocUnsafe(8 + body.length);
    frame.writeUInt32LE(Opcode.FRAME, 0);
    frame.writeUInt32LE(body.length, 4);
    body.copy(frame, 8);
    parser.push(frame);
    expect(onError).toHaveBeenCalledOnce();
  });
});
