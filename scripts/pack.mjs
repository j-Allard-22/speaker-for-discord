/**
 * Release packaging: strip the dev-only `Nodejs.Debug` flag (never ship an open
 * --inspect port), run `streamdeck pack`, restore the manifest.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = join(root, "packages", "plugin", "com.joallard.discord-speaker.sdPlugin");
const manifestPath = join(sdPlugin, "manifest.json");

const original = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(original);

if (manifest.Nodejs?.Debug !== undefined) {
  delete manifest.Nodejs.Debug;
  console.log("[pack] stripped Nodejs.Debug from manifest for release");
}

try {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  execSync(`streamdeck pack "${sdPlugin}" --force`, { stdio: "inherit", cwd: root });
} finally {
  writeFileSync(manifestPath, original); // dev manifest restored no matter what
  console.log("[pack] manifest restored (Debug re-enabled for dev)");
}
