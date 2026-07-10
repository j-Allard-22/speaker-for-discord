/**
 * Helper entry point: bind WS port (single-instance lock) FIRST, then wire the
 * Discord session and serve snapshots to AUTHENTICATED plugin clients.
 *
 * Crash policy: log + exit(1). No in-process resurrection — the plugin supervises.
 */
import {
  DEFAULT_HELPER_PORT,
  IDLE_EXIT_MS,
  helperStateDir,
  loadOrCreateSessionKey,
  type HelperToPluginMessage,
  type PluginToHelperMessage,
} from "@dsd/shared";
import { HelperLogger, resolveLogLevel } from "./logger.js";
import { startOrphanWatch } from "./orphan-watch.js";
import { SpeakerTracker } from "./speaker-tracker.js";
import { DiscordSession } from "./discord/session.js";
import { TokenStore } from "./discord/token-store.js";
import { HelperServer, PortOwnedError } from "./ws-server.js";

export const HELPER_VERSION = "1.0.0";
export const BUILD_ID = process.env["HELPER_BUILD_ID"] ?? "dev";

function parseArgs(argv: string[]): { port: number; idleExitMs: number; logLevel: string | undefined } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number.parseInt(get("--port") ?? "", 10);
  const idle = Number.parseInt(get("--idle-exit-ms") ?? "", 10);
  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_HELPER_PORT,
    idleExitMs: Number.isInteger(idle) && idle > 0 ? idle : IDLE_EXIT_MS,
    logLevel: get("--log-level") ?? process.env["DSD_LOG_LEVEL"],
  };
}

const args = parseArgs(process.argv.slice(2));
const logger = new HelperLogger({ minLevel: resolveLogLevel(args.logLevel) });

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

const stateDir = helperStateDir();
const sessionKey = loadOrCreateSessionKey(stateDir);
const tracker = new SpeakerTracker();
const store = new TokenStore(stateDir);
const session = new DiscordSession({ store, tracker, logger });

/** Last authRequired reason (cleared once the session gets somewhere) — part of the snapshot. */
let lastAuthRequired: HelperToPluginMessage | null = null;
/** Last non-recoverable error (e.g. oauth_exchange_failed) — must survive a plugin reload. */
let lastFatalError: HelperToPluginMessage | null = null;

function statusMessage(): HelperToPluginMessage {
  const s = session.status;
  return { type: "status", discord: s.discord, ...(s.detail !== undefined && { detail: s.detail }) };
}

function channelMessage(): HelperToPluginMessage {
  const c = session.channel;
  return {
    type: "channel",
    channelId: c.channelId,
    guildId: c.guildId,
    channelName: c.channelName,
    members: tracker.memberList,
  };
}

function speakerMessage(): HelperToPluginMessage {
  return { type: "speaker", speaker: tracker.currentSpeaker, speakingCount: tracker.speakingCount };
}

const server = new HelperServer({
  port: args.port,
  helperVersion: HELPER_VERSION,
  buildId: BUILD_ID,
  logger,
  sessionKey,
  snapshot: () => {
    const msgs = [statusMessage(), channelMessage(), speakerMessage()];
    if (lastAuthRequired) msgs.push(lastAuthRequired);
    if (lastFatalError) msgs.push(lastFatalError);
    return msgs;
  },
});

// ---- session -> broadcast wiring ----

session.on("status", (discord, detail) => {
  if (discord === "subscribed" || discord === "authenticating") {
    lastAuthRequired = null;
    lastFatalError = null;
  }
  server.broadcast({ type: "status", discord, ...(detail !== undefined && { detail }) });
});
session.on("channel", () => server.broadcast(channelMessage()));
session.on("authRequired", (reason) => {
  lastAuthRequired = { type: "authRequired", reason };
  server.broadcast(lastAuthRequired);
});
session.on("fatal", (message: string, code: "rpc_error" | "oauth_exchange_failed" = "rpc_error") => {
  lastFatalError = { type: "error", code, message, recoverable: false };
  server.broadcast(lastFatalError);
});

tracker.on("speaker", (speaker, speakingCount) => {
  server.broadcast({ type: "speaker", speaker, speakingCount });
});
tracker.on("roster", () => server.broadcast(channelMessage()));

// ---- plugin -> session wiring (authenticated clients only) ----

server.on("message", (msg: PluginToHelperMessage, reply: (m: HelperToPluginMessage) => void) => {
  switch (msg.type) {
    case "setCredentials":
      // `userInitiated` comes from the message and gates Discord's consent modal.
      // It must NEVER be hard-coded true: a reconnect push would then pop an
      // unprompted modal, and (pre-auth) an attacker could force one.
      logger.info("setCredentials received", { userInitiated: msg.userInitiated });
      session.setCredentials(msg.clientId, msg.clientSecret, msg.userInitiated);
      break;
    case "reauthorize":
      logger.info("reauthorize received");
      session.reauthorize();
      break;
    case "forgetCredentials":
      logger.info("forgetCredentials received");
      session.forgetCredentials();
      break;
    case "getState":
      // Unicast to the requester. Broadcasting here let any client force a roster
      // fan-out to every other client (amplification).
      reply(statusMessage());
      reply(channelMessage());
      reply(speakerMessage());
      if (lastAuthRequired) reply(lastAuthRequired);
      if (lastFatalError) reply(lastFatalError);
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
