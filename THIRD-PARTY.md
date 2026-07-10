# Third-party notices

This project is MIT licensed (see [LICENSE](LICENSE)). It redistributes and depends on
the following third-party software.

## Bundled in the released plugin

| Component | Where | License |
|---|---|---|
| **sdpi-components** v4.0.1 — Copyright Corsair Memory Inc. and other contributors ([sdpi-components.dev](https://sdpi-components.dev)) | Vendored at `…​.sdPlugin/ui/sdpi-components.js` (Elgato asks that it not be loaded from a CDN at runtime) | See the license header retained at the top of that file |
| **Lit** — Copyright 2019 Google LLC | Bundled inside `sdpi-components.js` | BSD-3-Clause |
| **@elgato/streamdeck** | Bundled into `bin/plugin.js` by Rollup | MIT |
| **ws** | Bundled into `bin/plugin.js` and `bin/helper.mjs` | MIT |

## Build-time only (not redistributed)

`@elgato/cli`, `typescript`, `rollup` (+ plugins), `esbuild`, `vitest`, `concurrently`.

## Trademarks

**Discord** is a trademark of Discord Inc. This project is an unofficial, third-party
plugin and is **not affiliated with, endorsed by, or sponsored by Discord Inc.** The
name follows Discord's brand guidelines ("… for Discord"), and the plugin's artwork
uses neither Discord's logo nor its brand colors.

**Stream Deck** and **Elgato** are trademarks of Corsair Memory, Inc. This project is
not affiliated with or endorsed by Elgato/Corsair.
