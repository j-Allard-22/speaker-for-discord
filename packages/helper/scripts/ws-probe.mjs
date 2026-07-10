#!/usr/bin/env node
/**
 * Dev/test WS client for the helper.
 *   node ws-probe.mjs [--port N] [--shutdown] [--forget] [--get-state]
 *
 * The helper discloses nothing until the peer proves it holds the session key, so the
 * probe must run the same 4-message handshake the plugin does. The HMAC is reimplemented
 * inline (node:crypto) to keep this script dependency-free.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(get("--port") ?? 39642);
const doShutdown = argv.includes("--shutdown");
const doForget = argv.includes("--forget");
const doGetState = argv.includes("--get-state");

// Must match HELPER_STATE_DIRNAME in packages/shared/src/constants.ts.
const STATE_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "SpeakerForDiscord");

let key;
try {
  key = readFileSync(join(STATE_DIR, "session.key"));
  if (key.length < 32) throw new Error("short key");
  key = key.subarray(0, 32);
} catch {
  console.error(`[probe] no session key at ${join(STATE_DIR, "session.key")}`);
  console.error("[probe] start the helper (or the plugin) once so it is created.");
  process.exit(2);
}

const proof = (role, sn, cn) => createHmac("sha256", key).update(`${role}:${sn}:${cn}`).digest("base64");

const clientNonce = randomBytes(24).toString("base64url");
let phase = "hello";

const ws = new WebSocket(`ws://127.0.0.1:${port}`);

ws.on("open", () => console.log(`[probe] connected to ws://127.0.0.1:${port}; awaiting hello`));

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (phase === "hello") {
    if (msg.type !== "hello") return fail(`expected hello, got ${msg.type}`);
    console.log(`[probe] hello (protocol v${msg.protocolVersion})`);
    ws.serverNonce = msg.serverNonce;
    ws.send(JSON.stringify({ type: "clientChallenge", clientNonce }));
    phase = "serverAuth";
    return;
  }

  if (phase === "serverAuth") {
    if (msg.type !== "serverAuth") return fail(`expected serverAuth, got ${msg.type}`);
    if (msg.serverProof !== proof("S", ws.serverNonce, clientNonce)) {
      return fail("SERVER FAILED AUTHENTICATION — something else owns this port");
    }
    console.log("[probe] server proved possession of the session key");
    ws.send(JSON.stringify({ type: "clientAuth", clientProof: proof("C", ws.serverNonce, clientNonce) }));
    phase = "welcome";
    return;
  }

  if (phase === "welcome") {
    if (msg.type !== "welcome") return fail(`expected welcome, got ${msg.type}`);
    console.log(`[probe] authenticated: helper v${msg.helperVersion} build ${msg.buildId} pid ${msg.pid}`);
    phase = "open";
    if (doShutdown) {
      ws.send(JSON.stringify({ type: "shutdown" }));
      console.log("[probe] shutdown sent");
      setTimeout(() => process.exit(0), 500);
    } else if (doForget) {
      ws.send(JSON.stringify({ type: "forgetCredentials" }));
      console.log("[probe] forgetCredentials sent");
    } else if (doGetState) {
      ws.send(JSON.stringify({ type: "getState" }));
    }
    return;
  }

  console.log(`[helper] ${raw}`);
});

function fail(why) {
  console.error(`[probe] ${why}`);
  ws.terminate();
  process.exit(1);
}

ws.on("close", () => {
  console.log("[probe] connection closed");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error(`[probe] ${err.message}`);
  process.exit(1);
});
