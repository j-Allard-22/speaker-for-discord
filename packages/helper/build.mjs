// esbuild bundle: src/main.ts -> <sdPlugin>/bin/helper.mjs (single ESM file)
// Also writes helper.meta.json { buildId } next to it — the plugin compares this
// against the running helper's hello.buildId to decide when to swap it.
import { context, build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "plugin", "com.vitamin.speaker-for-discord.sdPlugin", "bin");
const outFile = join(outDir, "helper.mjs");
const metaFile = join(outDir, "helper.meta.json");
const watch = process.argv.includes("--watch");

mkdirSync(outDir, { recursive: true });

/** buildId = content hash of the bundle — stable across rebuilds of identical source. */
function writeMeta() {
  const hash = createHash("sha256").update(readFileSync(outFile)).digest("hex").slice(0, 12);
  const buildId = `h-${hash}`;
  // Inject the real buildId by replacing the placeholder esbuild baked in.
  const bundled = readFileSync(outFile, "utf8").replaceAll("__HELPER_BUILD_ID__", buildId);
  writeFileSync(outFile, bundled);
  writeFileSync(metaFile, JSON.stringify({ buildId }, null, 2));
  console.log(`[helper build] ${buildId} -> ${outFile}`);
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [join(here, "src", "main.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "inline",
  // ws's optional native accelerators — not installed; ws falls back to pure JS.
  external: ["bufferutil", "utf-8-validate"],
  // CJS deps (ws) use require() of node builtins; provide it in ESM output.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  define: {
    "process.env.HELPER_BUILD_ID": JSON.stringify("__HELPER_BUILD_ID__"),
  },
  logLevel: "info",
};

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: "meta-on-end",
        setup(b) {
          b.onEnd((result) => {
            if (result.errors.length === 0) writeMeta();
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log("[helper build] watching…");
} else {
  await build(options);
  writeMeta();
}
