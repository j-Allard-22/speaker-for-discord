/**
 * Dev tool: renders every key state into one HTML sheet for visual inspection.
 *   npx esbuild packages/plugin/scripts/dump-states.ts --bundle --platform=node \
 *     --format=esm --outfile=<out>/dump-states.mjs && node <out>/dump-states.mjs <out>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderInitialsKey, renderSpeakerKey } from "../src/render/key-svg";
import {
  AUTH_NEEDED_KEY,
  AUTHORIZING_KEY,
  CONNECTING_KEY,
  HELPER_DOWN_KEY,
  IDLE_KEY,
  NO_CHANNEL_KEY,
  NO_DISCORD_KEY,
  PORT_CONFLICT_KEY,
  SETUP_KEY,
} from "../src/render/states";

// 1x1 red PNG placeholder for the avatar slot (real avatars come from the CDN).
const RED_PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const cells: Array<[string, string]> = [
  ["idle", IDLE_KEY],
  ["connecting", CONNECTING_KEY],
  ["authorizing", AUTHORIZING_KEY],
  ["auth needed", AUTH_NEEDED_KEY],
  ["setup", SETUP_KEY],
  ["no discord", NO_DISCORD_KEY],
  ["no channel", NO_CHANNEL_KEY],
  ["helper down", HELPER_DOWN_KEY],
  ["port conflict", PORT_CONFLICT_KEY],
  ["speaker (avatar)", renderSpeakerKey("Ada L.", RED_PX)],
  ["speaker (initials)", renderInitialsKey("Bartholomew III", "987654321")],
  ["speaker (emoji)", renderInitialsKey("👨‍👩‍👧‍👦 Fam", "123")],
];

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:8px;background:#111;font-family:Segoe UI,sans-serif}
  .grid{display:grid;grid-template-columns:repeat(4,90px);gap:10px}
  .cell{text-align:center}
  .cell span{color:#999;font-size:9px;display:block;margin-top:2px}
  svg{border:1px solid #333}
</style></head><body><div class="grid">
${cells.map(([label, svg]) => `<div class="cell">${svg}<span>${label}</span></div>`).join("\n")}
</div></body></html>`;

const outDir = process.argv[2] ?? ".";
writeFileSync(join(outDir, "states-sheet.html"), html);
console.log(`written ${join(outDir, "states-sheet.html")}`);
