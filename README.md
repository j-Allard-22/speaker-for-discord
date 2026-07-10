# Speaker for Discord — a Stream Deck plugin

Shows **who is currently speaking** in your Discord voice channel on a Stream Deck key:
their avatar, their name, updating live as the conversation moves.

No bot, no server, no telemetry. It talks to your local Discord desktop app and to
nothing else.

> Unofficial and not affiliated with Discord Inc. or Elgato/Corsair.

## Install

See **[docs/INSTALL.md](docs/INSTALL.md)** — about five minutes.

Requirements: Windows 10/11, Stream Deck app **7.1+**, and the Discord **desktop** app.
You do *not* need to install Node.js; Stream Deck ships its own runtime.

Because Discord gates the `rpc.voice.read` scope behind approval, each user registers
their own (free, private, 3-minute) Discord application:
**[docs/discord-app-setup.md](docs/discord-app-setup.md)**. Enable *Public Client* there
and the plugin uses PKCE — **no client secret is ever stored anywhere**.

## Key states

| Key shows | Meaning |
|---|---|
| avatar + name | that person is speaking |
| dim microphone | in a voice channel, nobody talking |
| `Connecting…` | contacting the helper / Discord (momentary, on first load) |
| `No VC` | connected, but not in a voice channel |
| `Discord?` | the Discord desktop app isn't running |
| `Setup` | no Client ID configured yet |
| `Check Discord` | the authorization dialog is open in Discord |
| `Authorize` | press *Re-authorize* in the key settings |
| red `!` | helper process down (auto-recovers) |
| `Port conflict` | another program owns port 39642 — change *Helper port* |

**Don't set a custom image on the key** — it would permanently cover the live avatar.

## How it works

```
Stream Deck ──► plugin (renders the key)
                  │ authenticated WebSocket on 127.0.0.1
                  ▼
               helper process (persists across plugin reloads)
                  │ named pipe — Discord RPC, scope rpc.voice.read
                  ▼
               Discord desktop app
```

The helper owns the single Discord connection, because Discord rate-limits RPC connects
to about two per minute and the plugin restarts often. The localhost link between them is
**mutually authenticated** with a per-machine key, so neither a web page you visit nor
another user on the PC can read your voice-channel roster or impersonate the helper —
see **[SECURITY.md](SECURITY.md)**.

## Privacy

Everything stays on your computer. The plugin's only outbound requests are Discord's
token endpoint and its avatar CDN. Full details, and how to delete your data:
**[PRIVACY.md](PRIVACY.md)**. To erase credentials, press **Forget credentials** in the
key settings.

## Development

**[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — setup, the two-process architecture, the
dev loop, and the gotchas worth knowing before you touch the Discord RPC layer.

```powershell
npm ci && npm run build && npm test
```

## Why not Xbox party chat?

It was researched thoroughly and it isn't possible: Windows exposes no API that says
*which* gamertag is speaking, and party audio reaches the PC as a single mixed stream.
The full findings are in [docs/research-report.md](docs/research-report.md).

## License

[MIT](LICENSE). Third-party notices: [THIRD-PARTY.md](THIRD-PARTY.md).
