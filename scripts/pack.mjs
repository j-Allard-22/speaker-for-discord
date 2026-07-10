/**
 * Release packaging. `Nodejs.Debug` must never ship (it opens a Node --inspect port on
 * every Stream Deck start). It is absent from the committed manifest; this script also
 * asserts that, so a stray dev edit cannot leak into a release.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = join(root, "packages", "plugin", "com.vitamin.speaker-for-discord.sdPlugin");
const manifest = JSON.parse(readFileSync(join(sdPlugin, "manifest.json"), "utf8"));

if (manifest.Nodejs?.Debug !== undefined) {
  console.error(
    "[pack] REFUSING: manifest.json has Nodejs.Debug set. Remove it before packaging —\n" +
      "       it enables a Node --inspect port in the released plugin.",
  );
  process.exit(1);
}

console.log(`[pack] ${manifest.Name} v${manifest.Version} (${manifest.UUID})`);
execSync(`streamdeck pack "${sdPlugin}" --force`, { stdio: "inherit", cwd: root });
