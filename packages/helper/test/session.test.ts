import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MemberInfo } from "@dsd/shared";
import { DiscordSession } from "../src/discord/session";
import { RpcClosedError, type DiscordRpcClient } from "../src/discord/rpc-client";
import { TokenStore } from "../src/discord/token-store";
import { HelperLogger } from "../src/logger";
import { SpeakerTracker, type RawVoiceState } from "../src/speaker-tracker";

function vs(id: string, name: string): RawVoiceState {
  return { user: { id, username: name, discriminator: "0" } };
}

/** Scripted RPC client: commands resolve via a handler map the test controls. */
class ScriptedClient extends EventEmitter {
  isClosed = false;
  commands: Array<{ cmd: string; args?: Record<string, unknown>; evt?: string }> = [];

  constructor(
    private readonly handler: (
      cmd: string,
      args?: Record<string, unknown>,
      evt?: string,
    ) => unknown | Promise<unknown>,
  ) {
    super();
  }

  async connect(): Promise<Record<string, unknown>> {
    return {};
  }

  async sendCommand(cmd: string, args?: Record<string, unknown>, evt?: string): Promise<unknown> {
    this.commands.push({ cmd, args, evt });
    return await this.handler(cmd, args, evt);
  }

  subscribe(evt: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.sendCommand("SUBSCRIBE", args, evt);
  }
  unsubscribe(evt: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.sendCommand("UNSUBSCRIBE", args, evt);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit("close", null);
  }

  dispatch(evt: string, data: unknown): void {
    this.emit("dispatch", evt, data);
  }
}

/** A client whose connect() never settles — parks the session loop for assertions. */
function stalledClient(): ScriptedClient {
  const c = new ScriptedClient(() => ({}));
  c.connect = () => new Promise<Record<string, unknown>>(() => undefined);
  return c;
}

function makeSession(client: ScriptedClient, clientFactory?: () => ScriptedClient) {
  const store = new TokenStore(mkdtempSync(join(tmpdir(), "dsd-session-")));
  store.save({ clientId: "app", clientSecret: "s", accessToken: "at", expiresAt: Date.now() + 1e9 });
  const tracker = new SpeakerTracker({ switchDebounceMs: 0, idleHoldMs: 0 });
  const logger = new HelperLogger({
    dir: mkdtempSync(join(tmpdir(), "dsd-session-log-")),
    mirrorToConsole: false,
    minLevel: "error",
  });
  const sleeps: number[] = [];
  const session = new DiscordSession({
    store,
    tracker,
    logger,
    clientFactory: () => (clientFactory ? clientFactory() : client) as unknown as DiscordRpcClient,
    authFn: async () => ({ user: { id: "me" }, auth: store.load()! }),
    sleepFn: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return { session, tracker, store, sleeps };
}

describe("DiscordSession bootstrap", () => {
  it("subscribes in the race-safe order and installs the GET_CHANNEL roster last", async () => {
    const GID = "100000000000000001"; // realistic snowflake — buildGuildIconUrl is strict
    const client = new ScriptedClient((cmd, args, evt) => {
      if (cmd === "SUBSCRIBE") return { evt };
      if (cmd === "GET_SELECTED_VOICE_CHANNEL") return { id: "c1" };
      if (cmd === "GET_CHANNEL")
        return { id: "c1", name: "General", guild_id: GID, voice_states: [vs("A", "Alice")] };
      if (cmd === "GET_GUILD") {
        expect(args).toEqual({ guild_id: GID });
        // .webp on purpose: the helper must REBUILD the URL (as .png), never forward it.
        return { icon_url: `https://cdn.discordapp.com/icons/${GID}/iconhash.webp` };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const { session, tracker } = makeSession(client);
    const statuses: string[] = [];
    session.on("status", (s: string) => statuses.push(s));

    session.startFromStored();
    await vi.waitFor(() => expect(session.status.discord).toBe("subscribed"));

    // Order: VOICE_CHANNEL_SELECT first, then GET_SELECTED_VOICE_CHANNEL (id only),
    // then the 5 channel events, then GET_CHANNEL as the authoritative roster
    // (+ GET_GUILD for the idle-key icon).
    const cmdSeq = client.commands.map((c) => c.evt ?? c.cmd);
    expect(cmdSeq).toEqual([
      "VOICE_CHANNEL_SELECT",
      "GET_SELECTED_VOICE_CHANNEL",
      "VOICE_STATE_CREATE",
      "VOICE_STATE_UPDATE",
      "VOICE_STATE_DELETE",
      "SPEAKING_START",
      "SPEAKING_STOP",
      "GET_CHANNEL",
      "GET_GUILD",
    ]);
    expect(tracker.memberList.map((m) => m.userId)).toEqual(["A"]);
    expect(session.channel).toEqual({
      channelId: "c1",
      guildId: GID,
      guildIconUrl: `https://cdn.discordapp.com/icons/${GID}/iconhash.png?size=128`,
      channelName: "General",
    });
    session.stop();
  });

  it("GET_GUILD failure is cosmetic: bootstrap still subscribes, icon falls back to null", async () => {
    const client = new ScriptedClient((cmd, _args, evt) => {
      if (cmd === "SUBSCRIBE") return { evt };
      if (cmd === "GET_SELECTED_VOICE_CHANNEL") return { id: "c1" };
      if (cmd === "GET_CHANNEL")
        return {
          id: "c1",
          name: "General",
          guild_id: "100000000000000001",
          voice_states: [vs("A", "Alice")],
        };
      if (cmd === "GET_GUILD") throw new Error("guild fetch denied");
      throw new Error(`unexpected ${cmd}`);
    });
    const { session, tracker } = makeSession(client);

    session.startFromStored();
    await vi.waitFor(() => expect(session.status.discord).toBe("subscribed"));
    expect(tracker.memberList.map((m) => m.userId)).toEqual(["A"]);
    expect(session.channel.guildId).toBe("100000000000000001");
    expect(session.channel.guildIconUrl).toBeNull();
    session.stop();
  });

  it("a pipe close during GET_GUILD aborts the bootstrap (no spurious subscribed)", async () => {
    // RpcClosedError is a SESSION failure: swallowing it would let the dead
    // bootstrap's tail run and broadcast "subscribed" (which wipes authRequired).
    const live = new ScriptedClient((cmd, _args, evt) => {
      if (cmd === "SUBSCRIBE") return { evt };
      if (cmd === "GET_SELECTED_VOICE_CHANNEL") return { id: "c1" };
      if (cmd === "GET_CHANNEL")
        return {
          id: "c1",
          name: "General",
          guild_id: "100000000000000001",
          voice_states: [vs("A", "Alice")],
        };
      if (cmd === "GET_GUILD") throw new RpcClosedError("connection closed");
      throw new Error(`unexpected ${cmd}`);
    });
    let calls = 0;
    // Second dial never settles, so the retry loop parks deterministically.
    const { session, tracker, sleeps } = makeSession(live, () =>
      ++calls === 1 ? live : stalledClient(),
    );
    const statuses: string[] = [];
    session.on("status", (s: string) => statuses.push(s));

    session.startFromStored();
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThan(0)); // failed -> backed off
    expect(statuses).not.toContain("subscribed"); // the dead bootstrap's tail never ran
    expect(tracker.memberList).toEqual([]); // roster never installed
    session.stop();
  });

  it("abandons a stale bootstrap when the channel switches during GET_GUILD", async () => {
    let releaseGuild: (() => void) | null = null;
    const client = new ScriptedClient(async (cmd, args, evt) => {
      if (cmd === "SUBSCRIBE" || cmd === "UNSUBSCRIBE") return { evt };
      if (cmd === "GET_SELECTED_VOICE_CHANNEL") return { id: "c1" };
      if (cmd === "GET_CHANNEL") {
        const id = String(args?.["channel_id"]);
        return id === "c1"
          ? { id, name: "OLD", guild_id: "100000000000000001", voice_states: [vs("OLD", "OldGuy")] }
          : { id, name: "NEW", guild_id: null, voice_states: [vs("NEW", "NewGuy")] };
      }
      if (cmd === "GET_GUILD") {
        await new Promise<void>((r) => (releaseGuild = r));
        return { icon_url: "https://cdn.discordapp.com/icons/100000000000000001/hash.png" };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const { session, tracker } = makeSession(client);
    session.startFromStored();

    // Wait until c1's GET_GUILD is in flight, then switch to c2 BEFORE it resolves.
    await vi.waitFor(() => expect(releaseGuild).not.toBeNull());
    client.dispatch("VOICE_CHANNEL_SELECT", { channel_id: "c2", guild_id: null });
    await vi.waitFor(() => expect(session.channel.channelName).toBe("NEW"));

    // Resolve the STALE c1 fetch — its roster and icon must be discarded.
    releaseGuild!();
    await new Promise((r) => setTimeout(r, 20));
    expect(tracker.memberList.map((m) => m.userId)).toEqual(["NEW"]);
    expect(session.channel).toEqual({
      channelId: "c2",
      guildId: null,
      guildIconUrl: null,
      channelName: "NEW",
    });
    session.stop();
  });

  it("buffers events arriving during bootstrap and replays them onto the roster", async () => {
    let releaseGetChannel!: () => void;
    const gate = new Promise<void>((r) => (releaseGetChannel = r));
    const client = new ScriptedClient(async (cmd, _args, evt) => {
      if (cmd === "SUBSCRIBE") return { evt };
      if (cmd === "GET_SELECTED_VOICE_CHANNEL") return { id: "c1" };
      if (cmd === "GET_CHANNEL") {
        await gate; // hold the roster back while events stream in
        return { id: "c1", name: "General", guild_id: null, voice_states: [vs("A", "Alice")] };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const { session, tracker } = makeSession(client);
    session.startFromStored();

    await vi.waitFor(() =>
      expect(client.commands.some((c) => c.cmd === "GET_CHANNEL")).toBe(true),
    );
    // Bootstrap window: a member joins AND starts speaking before the roster lands.
    client.dispatch("VOICE_STATE_CREATE", vs("D", "Dave"));
    client.dispatch("SPEAKING_START", { user_id: "D" });

    releaseGetChannel();
    await vi.waitFor(() => expect(session.status.discord).toBe("subscribed"));
    await vi.waitFor(() => {
      // Dave must exist AND be speaking — the ghost guard must NOT have eaten him.
      expect(tracker.memberList.map((m) => m.userId).sort()).toEqual(["A", "D"]);
      expect(tracker.speakingCount).toBe(1);
      expect(tracker.currentSpeaker?.userId).toBe("D");
    });
    session.stop();
  });

  it("abandons a stale bootstrap when the channel switches mid-flight (generation counter)", async () => {
    const releases = new Map<string, () => void>();
    const gateFor = (id: string) => new Promise<void>((r) => releases.set(id, r));
    const client = new ScriptedClient(async (cmd, args, evt) => {
      if (cmd === "SUBSCRIBE" || cmd === "UNSUBSCRIBE") return { evt };
      if (cmd === "GET_SELECTED_VOICE_CHANNEL") return { id: "c1" };
      if (cmd === "GET_CHANNEL") {
        const id = String(args?.["channel_id"]);
        await gateFor(id);
        return id === "c1"
          ? { id, name: "OLD", guild_id: null, voice_states: [vs("OLD", "OldGuy")] }
          : { id, name: "NEW", guild_id: null, voice_states: [vs("NEW", "NewGuy")] };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const { session, tracker } = makeSession(client);
    session.startFromStored();

    // Wait until c1's GET_CHANNEL is in flight, then switch to c2 BEFORE it resolves.
    await vi.waitFor(() => expect(releases.has("c1")).toBe(true));
    client.dispatch("VOICE_CHANNEL_SELECT", { channel_id: "c2", guild_id: null });
    await vi.waitFor(() => expect(releases.has("c2")).toBe(true));

    // Resolve the STALE c1 response first — it must be discarded.
    releases.get("c1")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(tracker.memberList.map((m) => m.userId)).not.toContain("OLD");

    releases.get("c2")!();
    await vi.waitFor(() => {
      expect(session.channel.channelName).toBe("NEW");
      expect(tracker.memberList.map((m) => m.userId)).toEqual(["NEW"]);
    });
    session.stop();
  });

  it("S7 regression: a healthy session that ends backs off before reconnecting", async () => {
    // Discord accepting the handshake then dropping the pipe (restart/flap) used to
    // reconnect in a tight loop, burning its ~2 connections/min budget.
    const live = new ScriptedClient((cmd, _args, evt) => {
      if (cmd === "SUBSCRIBE") return { evt };
      if (cmd === "GET_SELECTED_VOICE_CHANNEL") return { id: null };
      throw new Error(`unexpected ${cmd}`);
    });
    let calls = 0;
    // Second dial never settles, so the loop parks and `sleeps` stays deterministic.
    const { session, sleeps } = makeSession(live, () => (++calls === 1 ? live : stalledClient()));

    session.startFromStored();
    await vi.waitFor(() => expect(session.status.discord).toBe("no_channel"));
    expect(sleeps).toHaveLength(0); // no backoff on the happy path

    live.close(); // Discord goes away mid-session
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThan(0));
    expect(sleeps[0]).toBeGreaterThan(0); // slept before dialing again
    expect(calls).toBe(2); // exactly one reconnect attempt, after the sleep
    session.stop();
  });

  it("leaving voice (VOICE_CHANNEL_SELECT null) clears state and reports no_channel", async () => {
    const client = new ScriptedClient((cmd, _args, evt) => {
      if (cmd === "SUBSCRIBE" || cmd === "UNSUBSCRIBE") return { evt };
      if (cmd === "GET_SELECTED_VOICE_CHANNEL") return { id: "c1" };
      if (cmd === "GET_CHANNEL")
        return { id: "c1", name: "General", guild_id: null, voice_states: [vs("A", "Alice")] };
      throw new Error(`unexpected ${cmd}`);
    });
    const { session, tracker } = makeSession(client);
    const speakers: Array<MemberInfo | null> = [];
    tracker.on("speaker", (s: MemberInfo | null) => speakers.push(s));

    session.startFromStored();
    await vi.waitFor(() => expect(session.status.discord).toBe("subscribed"));
    client.dispatch("SPEAKING_START", { user_id: "A" });
    await vi.waitFor(() => expect(tracker.currentSpeaker?.userId).toBe("A"));

    client.dispatch("VOICE_CHANNEL_SELECT", { channel_id: null });
    await vi.waitFor(() => expect(session.status.discord).toBe("no_channel"));
    expect(tracker.currentSpeaker).toBeNull(); // stale speaker cleared IMMEDIATELY
    expect(speakers.at(-1)).toBeNull();
    // Old channel's events were unsubscribed (errors would be swallowed).
    expect(client.commands.filter((c) => c.cmd === "UNSUBSCRIBE")).toHaveLength(5);
    session.stop();
  });
});
