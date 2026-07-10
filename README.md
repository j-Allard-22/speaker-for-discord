# Discord Speaker — Stream Deck plugin

Shows **who is currently speaking** in your Discord voice channel on a Stream Deck key:
big avatar, name in a bottom band, updating live as speakers change. Built on Discord's
local RPC/IPC interface — no bot, no server, personal use.

> Xbox party chat was investigated and is **not** included: Windows exposes no API to
> identify *which* gamertag is speaking (see [docs/research-report.md](docs/research-report.md)).

## How it works

```
Stream Deck ──► plugin (key rendering)
                  │ localhost WebSocket
                  ▼
               helper process (persists across plugin reloads)
                  │ named pipe (Discord RPC, scopes: rpc + rpc.voice.read)
                  ▼
               Discord desktop app
```

The helper owns the single Discord connection (Discord rate-limits RPC connects to ~2/min)
and survives plugin restarts. Tokens are cached in `%LOCALAPPDATA%\DiscordSpeakerHelper\`
— the consent dialog appears **once**.

## Setup

1. Install the plugin (or `streamdeck link` the `.sdPlugin` folder for development).
2. Drag **Current Speaker** onto a key → it shows *Setup*.
3. Create your own Discord application (3 minutes, one time):
   see [docs/discord-app-setup.md](docs/discord-app-setup.md) — also embedded in the
   key's settings panel.
4. Paste Client ID + Client Secret into the key settings → approve Discord's
   authorization dialog once → done.

**Don't set a custom image on the key** — Stream Deck would permanently cover the live
avatar with it.

## Key states

| Key shows | Meaning |
|---|---|
| avatar + name | that person is talking |
| dim mic | in a voice channel, nobody talking |
| `No VC` | connected, but you're not in a voice channel |
| `Discord?` | Discord desktop app isn't running |
| `Setup` | client ID/secret not configured yet |
| `Authorize` | press *Re-authorize* in key settings, then approve in Discord |
| `Check Discord` | consent dialog is open in the Discord app |
| red `!` | helper process down (auto-recovers) |
| `Port conflict` | another app owns port 39642 — change *Helper port* in key settings |

## Development

```powershell
npm install               # once (Node 24+)
npm run build             # shared -> helper -> plugin
npm run watch             # dev loop; plugin hot-reloads, helper persists
npm run test              # vitest unit suite
npm run helper:probe      # watch the helper's live message stream
npm run helper:restart    # cycle the helper (picks up a fresh helper build)
npm run validate          # manifest/bundle validation
node scripts/pack.mjs     # release .streamDeckPlugin (strips the dev Debug flag)
```

Architecture details and hard-won constraints: [CLAUDE.md](CLAUDE.md).
Tokens/logs/avatar cache live in `%LOCALAPPDATA%\DiscordSpeakerHelper\`, never inside
the plugin folder.
