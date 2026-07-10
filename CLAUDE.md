# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Stream Deck plugin that renders the **currently-speaking Discord user** (avatar + truncated name) on a key.
Per-speaker Xbox party detection was researched and is a **dead end** on PC — deliberately out of scope
(see [docs/research-report.md](docs/research-report.md)). The full implementation plan (verified against
2026-07 docs, adversarially critiqued) lives at
`C:\Users\Axion\.claude\plans\please-analyze-compass-artifact-wf-300e7-quizzical-fiddle.md`.

## Commands

```powershell
npm run build            # shared (tsc) -> helper (esbuild) -> plugin (rollup)
npm run watch            # concurrently: helper esbuild --watch + plugin rollup -w (auto streamdeck restart)
npm run test             # vitest (all packages); single test: npx vitest run -t "name" or path to file
npm run validate         # streamdeck validate on the .sdPlugin folder
npm run helper:probe     # dev WS client: prints all helper messages
npm run helper:restart   # ws-probe --shutdown -> plugin respawns fresh helper build (~5 s)
streamdeck restart com.joallard.discord-speaker   # manual plugin reload
streamdeck link packages/plugin/com.joallard.discord-speaker.sdPlugin   # once per machine
```

Node 24+ required (`C:\Program Files\nodejs` — may need PATH prefix in fresh shells).
`@elgato/cli` is installed globally. Tests run against shared *source* via a vitest alias — no build needed first.

## Architecture (two processes, three packages)

```
Stream Deck app ──Elgato WS──► packages/plugin  (@elgato/streamdeck v2, key I/O + rendering ONLY)
                                   │ localhost WS 127.0.0.1:39642 (plugin = client)
                                   ▼
                               packages/helper  (plain Node, spawned detached, SURVIVES plugin hot-reloads)
                                   │ named pipe \\?\pipe\discord-ipc-0..9 (raw IPC, no library)
                                   ▼
                               Discord desktop client
```

- `packages/shared` — WS protocol types (`messages.ts`) + constants. Built with tsc to `dist/`; build it before the others (root `npm run build` does).
- `packages/helper` — owns the single Discord RPC connection (Discord hard-limits ~2 connections/min — this is WHY the helper survives plugin restarts). esbuild-bundled into `<sdPlugin>/bin/helper.mjs` + `helper.meta.json` (buildId used by the plugin to detect stale helpers).
- `packages/plugin` — hand-authored equivalent of the `streamdeck create` scaffold (wizard is interactive). Rollup-bundled to `<sdPlugin>/bin/plugin.js`.

## Non-obvious constraints (violating these breaks the app)

- Discord speaking events need scope **`rpc.voice.read`** — the legacy docs' `rpc.notifications.read` is wrong.
- **SUBSCRIBE/UNSUBSCRIBE carry the event name in the TOP-LEVEL `evt` field of the envelope, not inside `args`.**
- SDK v2 gotchas (differ from v1 docs/templates): no `LogLevel` export — `streamDeck.logger.setLevel("debug")` takes a string; the `@action` decorator uses **standard TC39 decorators** — do NOT set `experimentalDecorators` in tsconfig; `streamDeck.ui.sendToPropertyInspector(...)` (no `.current`).
- Render the whole key as ONE SVG via `setImage(data:image/svg+xml,<encodeURIComponent>)` + `setTitle("")`. No GIF support.
- All helper runtime state (auth.json, helper.log, avatar cache, cwd) lives in `%LOCALAPPDATA%\DiscordSpeakerHelper\` — **nothing under `.sdPlugin` is ever opened for write** (Windows file locks would break plugin updates; pack would ship caches).
- The consent modal (AUTHORIZE) may only run from explicit user action in the PI — never automatically at boot.
- Helper reconnect backoff: pipe-refused = fast ramp OK; connected-then-failed = ≥31 s between attempts.
- Secrets: client ID/secret in **global** settings only (never per-action — profiles export those); logger redacts `access_token/refresh_token/client_secret/code`.
- Manifest ships `Nodejs.Debug: "enabled"` for dev; must be stripped when packing (M10 transform).
- Block comments containing `*/` inside patterns like `SPEAKING_*/...` self-terminate — mind TS comments.

## Verification

Mock-first: vitest covers codec/wire-shape/normalizer/tracker-timing/token-store/redaction with no external deps.
Live: real Stream Deck + Discord are typically running on this machine; helper can run standalone
(`node <sdPlugin>/bin/helper.mjs --port 39642` + `npm run helper:probe`) without Stream Deck.
The milestone-by-milestone verification matrix is in the plan file.
