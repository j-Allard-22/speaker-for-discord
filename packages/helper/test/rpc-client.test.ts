import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameParser, Opcode } from "../src/discord/ipc-transport";
import { DiscordRpcClient, RpcCommandError } from "../src/discord/rpc-client";

/** Minimal in-memory stand-in for the pipe socket. */
class MockSocket extends EventEmitter {
  frames: Array<{ op: number; payload: Record<string, unknown> }> = [];
  private parser = new FrameParser();

  constructor() {
    super();
    this.parser.on("frame", (op: number, payload: unknown) =>
      this.frames.push({ op, payload: payload as Record<string, unknown> }),
    );
  }

  write(buf: Buffer): boolean {
    this.parser.push(buf);
    return true;
  }

  destroy(): void {
    this.emit("close");
  }

  /** Simulate the server sending a frame. */
  reply(op: number, payload: unknown): void {
    this.emit("data", encodeFrame(op as 0 | 1 | 2 | 3 | 4, payload));
  }
}

async function connectedClient(): Promise<{ client: DiscordRpcClient; socket: MockSocket }> {
  const socket = new MockSocket();
  const client = new DiscordRpcClient({
    clientId: "app123",
    discover: async () => socket as unknown as net.Socket,
    commandTimeoutMs: 500,
  });
  const ready = client.connect();
  await new Promise((r) => setImmediate(r)); // let the async discover() resolve + handshake write
  // Handshake must have been written before READY arrives.
  expect(socket.frames).toEqual([
    { op: Opcode.HANDSHAKE, payload: { v: 1, client_id: "app123" } },
  ]);
  socket.reply(Opcode.FRAME, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } });
  await ready;
  return { client, socket };
}

describe("DiscordRpcClient", () => {
  it("handshakes and resolves on READY", async () => {
    const { client } = await connectedClient();
    expect(client.isClosed).toBe(false);
  });

  it("SUBSCRIBE puts the event name in the TOP-LEVEL evt field, not args", async () => {
    // This exact wire shape is the difference between working voice events and silence.
    const { client, socket } = await connectedClient();
    const promise = client.subscribe("SPEAKING_START", { channel_id: "c1" });

    const sub = socket.frames.at(-1)!;
    expect(sub.op).toBe(Opcode.FRAME);
    expect(sub.payload["cmd"]).toBe("SUBSCRIBE");
    expect(sub.payload["evt"]).toBe("SPEAKING_START"); // top-level
    expect(sub.payload["args"]).toEqual({ channel_id: "c1" }); // evt NOT in args
    expect(typeof sub.payload["nonce"]).toBe("string");

    socket.reply(Opcode.FRAME, {
      cmd: "SUBSCRIBE",
      data: { evt: "SPEAKING_START" },
      evt: null,
      nonce: sub.payload["nonce"],
    });
    await expect(promise).resolves.toEqual({ evt: "SPEAKING_START" });
  });

  it("UNSUBSCRIBE uses the same top-level evt envelope", async () => {
    const { client, socket } = await connectedClient();
    void client.unsubscribe("SPEAKING_STOP", { channel_id: "c1" }).catch(() => undefined);
    const un = socket.frames.at(-1)!;
    expect(un.payload["cmd"]).toBe("UNSUBSCRIBE");
    expect(un.payload["evt"]).toBe("SPEAKING_STOP");
    expect(un.payload["args"]).toEqual({ channel_id: "c1" });
  });

  it("rejects nonce-matched ERROR responses with code + message", async () => {
    const { client, socket } = await connectedClient();
    const promise = client.sendCommand("GET_CHANNEL", { channel_id: "nope" });
    const cmd = socket.frames.at(-1)!;
    socket.reply(Opcode.FRAME, {
      cmd: "GET_CHANNEL",
      evt: "ERROR",
      data: { code: 4005, message: "no such channel" },
      nonce: cmd.payload["nonce"],
    });
    await expect(promise).rejects.toThrowError(RpcCommandError);
    await expect(
      promise.catch((e: RpcCommandError) => ({ code: e.code, msg: e.message })),
    ).resolves.toEqual({ code: 4005, msg: "no such channel" });
  });

  it("emits normalized dispatches (camelCase bug handled)", async () => {
    const { client, socket } = await connectedClient();
    const dispatches: Array<{ evt: string; data: unknown }> = [];
    client.on("dispatch", (evt: string, data: unknown) => dispatches.push({ evt, data }));
    // Buggy camelCase payload from the client:
    socket.reply(Opcode.FRAME, {
      cmd: "DISPATCH",
      evt: "SPEAKING_START",
      data: { userId: "42", channelId: "c1" },
    });
    expect(dispatches).toEqual([
      { evt: "SPEAKING_START", data: { user_id: "42", channel_id: "c1" } },
    ]);
  });

  it("answers PING with PONG", async () => {
    const { socket } = await connectedClient();
    socket.reply(Opcode.PING, { marco: true });
    const last = socket.frames.at(-1)!;
    expect(last.op).toBe(Opcode.PONG);
    expect(last.payload).toEqual({ marco: true });
  });

  it("rejects all pending commands when the pipe closes", async () => {
    const { client, socket } = await connectedClient();
    const p = client.sendCommand("GET_SELECTED_VOICE_CHANNEL");
    socket.destroy();
    await expect(p).rejects.toThrow();
    expect(client.isClosed).toBe(true);
  });
});
