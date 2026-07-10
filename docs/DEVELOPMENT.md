# Development setup

Setting up the repo on a fresh Windows PC.

## Prerequisites

```powershell
winget install OpenJS.NodeJS.LTS      # Node 24+ (the SDK requires it)
npm install -g @elgato/cli            # streamdeck CLI
```

Plus the **Stream Deck app 7.1+** and the **Discord desktop app**.

> Fresh shells may not have Node on `PATH` yet:
> `$env:PATH = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:PATH"`

## Bootstrap

```powershell
git clone https://github.com/j-Allard-22/speaker-for-discord
cd speaker-for-discord
npm ci
```

> `esbuild`'s platform binary (`@esbuild/win32-x64`) is a resolved *optionalDependency*
> in the lockfile, so `npm ci` installs it directly — the build works even if npm 11
> skips esbuild's (fallback) postinstall. If you ever see `npm warn allow-scripts` and a
> broken esbuild, run `npm approve-scripts esbuild && npm rebuild esbuild`.

Then link the plugin into the Stream Deck app (once per machine):

```powershell
npm run build
streamdeck link packages/plugin/com.vitamin.speaker-for-discord.sdPlugin
streamdeck dev          # enables developer mode: restart deep-links + PI debugging
```

Without `streamdeck dev`, `streamdeck restart` is silently ignored — the app logs
*"Feature only enabled in developer mode"*.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run build` | shared (tsc) → helper (esbuild) → plugin (rollup) |
| `npm run watch` | watch **both**: plugin (rebuild + auto `streamdeck restart`) and helper (rebuilds the bundle only) |
| `npm test` | vitest, all packages |
| `npm run typecheck` | tsc over src **and** tests |
| `npm run validate` | `streamdeck validate` on the bundle |
| `npm run helper:probe` | authenticate to the running helper and print its live message stream |
| `npm run helper:restart` | ask the helper to exit; the plugin respawns the fresh build |
| `node scripts/pack.mjs` | build a release `.streamDeckPlugin` |

Single test file: `npx vitest run packages/helper/test/ws-auth.test.ts`
Single test by name: `npx vitest run -t "reflection"`

## Architecture in one picture

```
Stream Deck app ──Elgato WS──► packages/plugin        (key rendering only)
                                   │  authenticated WS on 127.0.0.1:39642
                                   ▼
                               packages/helper        (a DETACHED process)
                                   │  named pipe \\?\pipe\discord-ipc-0..9
                                   ▼
                               Discord desktop app
```

**Why two processes?** Discord rate-limits RPC connections to roughly **2 per minute**.
`npm run watch` restarts the plugin on every save. If the plugin owned the Discord
connection, a few saves would exhaust that budget and Discord would stop answering. So
the helper is spawned *detached*, outlives plugin restarts, and a reloaded plugin simply
**adopts** it (`helper-manager.ts`). The helper exits by itself ~2 minutes after its
last client disconnects (`orphan-watch.ts`), so it never becomes an orphan.

`packages/shared` holds the wire protocol (`messages.ts`) and the session-key crypto
(`session-key.ts`) so the two sides can never drift.

### The helper dev loop

`npm run watch` rebuilds the helper bundle on save too, but the **running** helper — a
detached process — keeps executing the old code. To swap it in:

```powershell
npm run helper:restart          # helper exits; plugin spawns the fresh build
```

(If the watcher isn't running, `npm run build -w @dsd/helper` first. The plugin also swaps
a stale helper automatically at startup by comparing `hello`/`welcome` `buildId` against
`bin/helper.meta.json`.)

You can also run the helper completely standalone — no Stream Deck needed:

```powershell
node packages/plugin/com.vitamin.speaker-for-discord.sdPlugin/bin/helper.mjs --port 39642 --log-level debug
npm run helper:probe
```

## Gotchas that will cost you an hour

- **SDK v2 differs from most tutorials.** There is no `LogLevel` export
  (`logger.setLevel("debug")` takes a string); `@action` uses standard TC39 decorators,
  so do **not** set `experimentalDecorators`; it's `streamDeck.ui.sendToPropertyInspector(…)`
  with no `.current`.
- **Never call `getGlobalSettings()` inside `onDidReceiveGlobalSettings`.** The request
  resolves via an event that also fires the listener → infinite loop (~900 msg/s,
  observed). `useExperimentalMessageIdentifiers = true` filters it; the dedupe in
  `plugin.ts` is the real guard.
- **Discord RPC `SUBSCRIBE`/`UNSUBSCRIBE` put the event name in a top-level `evt` field**,
  not inside `args`. Getting this wrong yields silence, not an error.
- The scope is **`rpc.voice.read`**. The legacy Discord docs name `rpc.notifications.read`; it's wrong.
- **All helper state lives in `%LOCALAPPDATA%\SpeakerForDiscord\`.** Never open a file
  for write inside the `.sdPlugin` folder: Windows locks would break plugin updates, and
  `streamdeck pack` would ship your caches.
- Render the whole key as **one SVG** via `setImage(...)` + `setTitle("")`. No GIF support.
- Block comments containing `*/` (e.g. writing `SPEAKING_*/VOICE_*`) terminate early and
  produce baffling TS parse errors.

## Testing

`npm test` needs no Discord, no Stream Deck, and no network. Notable suites:

- `packages/shared/test/session-key.test.ts` — reflection and replay regressions.
- `packages/helper/test/ws-auth.test.ts` — binds a real server and proves an
  unauthenticated peer gets no roster, `getState` is unicast, `Origin` is refused, an
  oversized frame doesn't crash the helper.
- `packages/plugin/test/helper-client.test.ts` — a fake helper that can't prove
  possession never receives `setCredentials`.

For a live check against a *running* helper, use `npm run helper:probe` (it performs the
full authenticated handshake and prints the message stream). `SECURITY.md` documents the
handshake and threat model these tests defend.
