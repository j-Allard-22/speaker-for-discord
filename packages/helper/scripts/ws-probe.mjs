#!/usr/bin/env node
/**
 * Dev/test WS client for the helper.
 *   node ws-probe.mjs [--port N] [--shutdown]
 * Prints every message the helper sends; --shutdown asks it to exit (the plugin
 * will respawn a fresh build within ~5 s — this is the helper dev loop).
 */
import { WebSocket } from "ws";

const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(get("--port") ?? 39642);
const doShutdown = argv.includes("--shutdown");

const ws = new WebSocket(`ws://127.0.0.1:${port}`);

ws.on("open", () => {
  console.log(`[probe] connected to ws://127.0.0.1:${port}`);
  if (doShutdown) {
    ws.send(JSON.stringify({ type: "shutdown" }));
    console.log("[probe] shutdown sent");
    setTimeout(() => process.exit(0), 500);
  }
});

ws.on("message", (raw) => {
  console.log(`[helper] ${raw}`);
});

ws.on("close", () => {
  console.log("[probe] connection closed");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error(`[probe] ${err.message}`);
  process.exit(1);
});
