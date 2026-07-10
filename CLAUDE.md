# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**Speaker for Discord** — a Stream Deck plugin (Windows only) that renders the currently-speaking
Discord voice member (avatar + truncated name) on a key. Per-speaker Xbox party detection was
researched and is a **dead end** on PC — deliberately out of scope (see [docs/research-report.md](docs/research-report.md)).

Plugin UUID `com.vitamin.speaker-for-discord` — **immutable once published**.

## Commands

```powershell
npm run build            # shared (tsc) -> helper (esbuild) -> plugin (rollup)
npm run watch            # rebuild + auto `streamdeck restart` (plugin only; helper persists)
npm test                 # vitest; single file: npx vitest run <path>; by name: npx vitest run -t "name"
npm run typecheck        # tsc over src AND tests (tsconfig.test.json)
npm run validate         # streamdeck validate
npm run helper:probe     # authenticate to the running helper, print its live message stream
npm run helper:restart   # helper exits; plugin respawns the fresh build  <- the helper dev loop
node scripts/pack.mjs    # release .streamDeckPlugin (refuses if Nodejs.Debug is set)
streamdeck link packages/plugin/com.vitamin.speaker-for-discord.sdPlugin   # once per machine
streamdeck dev           # once; otherwise `streamdeck restart` is silently ignored
```

Node 24+ (`C:\Program Files\nodejs` — fresh shells may need it prepended to PATH).
Tests need no Discord, no Stream Deck, and no network.

## Architecture (two processes, three packages)

```
Stream Deck ──Elgato WS──► packages/plugin   (@elgato/streamdeck v2 — key I/O + rendering ONLY)
                              │ authenticated WS 127.0.0.1:39642 (plugin = client)
                              ▼
                           packages/helper   (detached; SURVIVES plugin hot-reloads)
                              │ named pipe \\?\pipe\discord-ipc-0..9 (raw IPC, no library)
                              ▼
                           Discord desktop app
```

- `packages/shared` — wire protocol (`messages.ts`), constants, **`session-key.ts`** (the localhost
  auth crypto), `state-dir.ts`. Built with tsc first; both sides import it so they cannot drift.
- `packages/helper` — owns the single Discord RPC connection. Discord rate-limits RPC connects to
  ~2/min — that is WHY the helper outlives the plugin. esbuild → `<sdPlugin>/bin/helper.mjs` + `helper.meta.json`.
- `packages/plugin` — hand-authored equivalent of the `streamdeck create` scaffold. Rollup → `bin/plugin.js`.

## Security invariants (do not regress — each has a regression test)

- **The localhost link is mutually authenticated.** 4-message handshake with a shared
  `%LOCALAPPDATA%\SpeakerForDiscord\session.key`. The **server proves possession first** (so a port
  squatter never receives `setCredentials`), the client proves it before **any** Discord state is sent.
  Proofs use `"S:"`/`"C:"` domain tags — without them a key-less peer could reflect the client's
  own proof back. See `SECURITY.md` and `packages/helper/test/ws-auth.test.ts`.
- `hello` must disclose nothing (no pid/buildId — those moved to the post-auth `welcome`).
- `Origin`-bearing upgrades are refused (browsers always send it; the `ws` client never does).
- Every socket needs an `error` listener, or one oversized frame crashes the helper via `uncaughtException`.
- `userInitiated` comes from the message and gates Discord's consent modal. **Never hard-code it true**:
  a reconnect push would pop an unprompted modal.
- `getState` replies via the `reply` callback — never `broadcast` (amplification).
- Avatar URLs are host-pinned to `https://cdn.discordapp.com`.
- Logger defaults to `info`; `redact()` covers wire *and* camelCase (`clientSecret`, `accessToken`, …).
- Reconnects must back off — including after a **healthy** session's pipe closes — or a flapping
  Discord burns the ~2/min budget.

## Other non-obvious constraints

- Discord speaking events need scope **`rpc.voice.read`** — the legacy docs' `rpc.notifications.read` is wrong.
- **SUBSCRIBE/UNSUBSCRIBE carry the event name in the TOP-LEVEL `evt` field, not inside `args`.**
- PKCE: `AUTHORIZE` sends `code_challenge`/`S256`; `client_secret` is sent **iff** the user supplied one
  (Public Client apps have none). A rejected *code* exchange is loud+terminal; a rejected *refresh* is
  silent and degrades to an "Authorize" prompt.
- **Verified live (2026-07):** an `authorization_code` exchange with `code_verifier` and **no** secret
  succeeds *even when the app is not a Public Client* — but the `refresh_token` grant then returns
  `401 invalid_client`. So "no secret + Public Client off" works for ~7 days and then dies. `auth.ts`
  detects that exact case (rejected refresh + no stored secret) and attaches `PUBLIC_CLIENT_HINT`,
  which the session surfaces as the status detail in the property inspector.
- SDK v2 gotchas: no `LogLevel` export (`setLevel("debug")` takes a string); `@action` uses standard TC39
  decorators — do **not** set `experimentalDecorators`; `streamDeck.ui.sendToPropertyInspector(...)` (no `.current`).
- **Never call `getGlobalSettings()` inside `onDidReceiveGlobalSettings`** — the request resolves via an
  event that also fires the listener (infinite loop, ~900 msg/s observed).
- Whole key = ONE SVG via `setImage("data:image/svg+xml," + encodeURIComponent(svg))` + `setTitle("")`. No GIF.
- All helper runtime state lives in `%LOCALAPPDATA%\SpeakerForDiscord\` — **nothing under `.sdPlugin` is
  ever opened for write** (Windows locks break plugin updates; pack would ship caches).
- Manifest must NOT contain `Nodejs.Debug` (open `--inspect` port); `scripts/pack.mjs` enforces this.
- Block comments containing `*/` (e.g. `SPEAKING_*/VOICE_*`) self-terminate — mind TS comments.

## Publishing

MIT, Windows-only, distributed as a `.streamDeckPlugin` on GitHub Releases (Elgato Marketplace later:
needs a Maker org, 3–10 gallery images at 1920×960, and a hosted privacy-policy URL).
Discord brand rules forbid the "Discord X" name pattern and copying their colors — hence
"Speaker for Discord" and the non-Blurple icon.
