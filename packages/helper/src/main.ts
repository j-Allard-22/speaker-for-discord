/**
 * Helper entry point: bind WS port (single-instance lock) FIRST, then wire the
 * Discord session and serve snapshots to plugin clients.
 *
 * Crash policy: log + exit(1). No in-process resurrection — the plugin supervises.
 */
import { DEFAULT_HELPER_PORT, IDLE_EXIT_MS, type HelperToPluginMessage } from "@dsd/shared";
import { HelperLogger } from "./logger.js";
import { startOrphanWatch } from "./orphan-watch.js";
import { SpeakerTracker } from "./speaker-tracker.js";
import { DiscordSession } from "./discord/session.js";
import { TokenStore } from "./discord/token-store.js";
import { HelperServer, PortOwnedError } from "./ws-server.js";

export const HELPER_VERSION = "0.1.0";
export const BUILD_ID = process.env.HELPER_BUILD_ID ?? "dev";

function parseArgs(argv: string[]): { port: number; idleExitMs: number } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    port: Number(get("--port") ?? DEFAULT_HELPER_PORT),
    idleExitMs: Number(get("--idle-exit-ms") ?? IDLE_EXIT_MS),
  };
}

const args = parseArgs(process.argv.slice(2));
const logger = new HelperLogger();

process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { message: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { message: String(reason) });
  process.exit(1);
});

logger.info("helper starting", {
  version: HELPER_VERSION,
  buildId: BUILD_ID,
  port: args.port,
  idleExitMs: args.idleExitMs,
  pid: process.pid,
});

const tracker = new SpeakerTracker();
const store = new TokenStore();
const session = new DiscordSession({ store, tracker, logger });

// Last authRequired reason (cleared when the session gets somewhere) — part of the snapshot.
let lastAuthRequired: HelperToPluginMessage | null = null;

const server = new HelperServer({
  port: args.port,
  helperVersion: HELPER_VERSION,
  buildId: BUILD_ID,
  logger,
  snapshot: () => {
    const s = session.status;
    const c = session.channel;
    const msgs: HelperToPluginMessage[] = [
      { type: "status", discord: s.discord, ...(s.detail !== undefined && { detail: s.detail }) },
      {
        type: "channel",
        channelId: c.channelId,
        guildId: c.guildId,
        channelName: c.channelName,
        members: tracker.memberList,
      },
      { type: "speaker", speaker: tracker.currentSpeaker, speakingCount: tracker.speakingCount },
    ];
    if (lastAuthRequired) msgs.push(lastAuthRequired);
    return msgs;
  },
});

// ---- session -> broadcast wiring ----

session.on("status", (discord, detail) => {
  if (discord === "subscribed" || discord === "authenticating") lastAuthRequired = null;
  server.broadcast({ type: "status", discord, ...(detail !== undefined && { detail }) });
});
session.on("channel", (info) => {
  server.broadcast({
    type: "channel",
    channelId: info.channelId,
    guildId: info.guildId,
    channelName: info.channelName,
    members: tracker.memberList,
  });
});
session.on("authRequired", (reason) => {
  lastAuthRequired = { type: "authRequired", reason };
  server.broadcast(lastAuthRequired);
});
session.on("fatal", (message) => {
  server.broadcast({ type: "error", code: "rpc_error", message, recoverable: false });
});

tracker.on("speaker", (speaker, speakingCount) => {
  server.broadcast({ type: "speaker", speaker, speakingCount });
});
tracker.on("roster", () => {
  const c = session.channel;
  server.broadcast({
    type: "channel",
    channelId: c.channelId,
    guildId: c.guildId,
    channelName: c.channelName,
    members: tracker.memberList,
  });
});

// ---- plugin -> session wiring ----

server.on("message", (msg) => {
  switch (msg.type) {
    case "setCredentials":
      logger.info("setCredentials received");
      session.setCredentials(msg.clientId, msg.clientSecret, true);
      break;
    case "reauthorize":
      logger.info("reauthorize received");
      session.reauthorize();
      break;
    case "getState":
      // Snapshot is pushed on connect; re-broadcast for explicit requests.
      for (const m of [
        { type: "status" as const, discord: session.status.discord },
        {
          type: "channel" as const,
          channelId: session.channel.channelId,
          guildId: session.channel.guildId,
          channelName: session.channel.channelName,
          members: tracker.memberList,
        },
        {
          type: "speaker" as const,
          speaker: tracker.currentSpeaker,
          speakingCount: tracker.speakingCount,
        },
      ]) {
        server.broadcast(m);
      }
      break;
    case "shutdown":
      logger.info("shutdown requested by client");
      shutdown(0);
      break;
  }
});

function shutdown(code: number): void {
  try {
    session.stop();
    server.close();
  } finally {
    process.exit(code);
  }
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// ---- boot ----

try {
  await server.start();
} catch (err) {
  if (err instanceof PortOwnedError) {
    // A healthy incumbent owns the port — we're the redundant instance. Clean exit.
    logger.info("another helper owns the port; exiting", { port: args.port });
    process.exit(0);
  }
  throw err;
}

startOrphanWatch(server, args.idleExitMs, () => {
  logger.info("no clients for idle window; exiting (orphan prevention)");
  shutdown(0);
});

// Boot-auth from stored tokens (never pops a consent modal — parks if tokens are dead).
session.startFromStored();
