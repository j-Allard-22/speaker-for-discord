# Installing Speaker for Discord on another PC

Takes about five minutes. Roughly: install the plugin → create a small Discord app of
your own → paste one ID → approve one dialog.

## 1. Requirements

| | |
|---|---|
| **Windows** | 10 or 11 |
| **Stream Deck app** | **7.1 or newer** (Help → About; update from the app if older) |
| **Discord** | the **desktop** app, running and signed in — the browser version will not work |
| Node.js | **not required** — Stream Deck ships its own Node runtime, and the plugin uses it |

Any Stream Deck with keys works (Mini, MK.2, XL, +, Neo).

## 2. Install the plugin

1. Download `com.vitamin.speaker-for-discord.streamDeckPlugin` from the
   [latest release](https://github.com/j-Allard-22/speaker-for-discord/releases/latest).
2. Double-click it. Stream Deck will ask to install — confirm.
3. In the Stream Deck app, find **Current Speaker** in the actions list on the right and
   drag it onto a key.

The key will show a **gear** icon — that's "setup needed".

> **Don't set a custom image on this key.** A user-set image permanently overrides
> anything the plugin draws, and the key will look frozen.

## 3. Create your Discord application

Discord's "who is speaking" permission (`rpc.voice.read`) is approval-gated, so it only
works for an application **you own**. Making one is free and takes ~3 minutes; it never
joins a server and has no bot.

Follow **[docs/discord-app-setup.md](discord-app-setup.md)** — the same steps are also
embedded in the key's settings panel.

The short version:

1. <https://discord.com/developers/applications> → **New Application**.
2. Copy the **Application ID**.
3. **OAuth2** tab → turn **Public Client** on.
4. **OAuth2 → Redirects** → add exactly `http://127.0.0.1` → Save.

## 4. Connect it

1. Click the **Current Speaker** key in the Stream Deck app to open its settings.
2. Paste the **Application ID** into **Client ID**. Leave **Client Secret** blank.
3. Discord pops an authorization dialog — click **Authorize**. This happens **once**;
   the token is cached and refreshed silently afterwards.

Join a voice channel and start talking. The key should show the speaker's avatar and name.

## 5. What the key is telling you

| Key shows | Meaning |
|---|---|
| avatar + name | that person is speaking |
| dim microphone | you're in a voice channel, nobody is talking |
| `Connecting…` | contacting the helper / Discord (momentary, on first load) |
| `No VC` | connected, but you're not in a voice channel |
| `Discord?` | the Discord desktop app isn't running |
| `Setup` (gear) | no Client ID configured yet |
| `Check Discord` | the authorization dialog is open in the Discord app |
| `Authorize` | press **Re-authorize** in the key settings |
| red `!` | the helper process is down (it recovers on its own) |
| `Port conflict` | another program owns port 39642 — change **Helper port** in the settings |

## Troubleshooting

**Nothing happens after I click Authorize.**
Make sure the Discord *desktop* app is running and signed into the account that owns the
application. Then press **Re-authorize** in the key settings.

**The key says "Discord rejected the token exchange".**
Your app has *Public Client* off and no secret. Either turn **Public Client** on
(OAuth2 tab), or press **Reset Secret** there and paste it into **Client Secret**.

**The key says `Port conflict`.**
Something else is listening on `127.0.0.1:39642`. Type a different port (1024–65535)
into **Helper port** in the key settings.

**It worked for a week, now the key says `Authorize`.**
The plugin couldn't refresh your token. Discord allows the *first* sign-in with PKCE and
no secret, but it refuses to refresh unless the app is a **Public Client**. Open the key
settings — the status line will tell you — then either turn on **Public Client** on your
app's OAuth2 tab, or paste a **Client Secret**. Press **Re-authorize** once afterwards.

**The key says `Authorize` at some other time.**
Your token was revoked (Discord → *User Settings → Authorized Apps*). Press **Re-authorize**.

**Where are the logs?**
`%LOCALAPPDATA%\SpeakerForDiscord\helper.log` (secrets are redacted). For more detail,
set the environment variable `DSD_LOG_LEVEL=debug` and restart Stream Deck.

## Uninstalling

Right-click the plugin in Stream Deck → **Uninstall**. That leaves your credentials
behind; to remove them, press **Forget credentials** in the key settings *before*
uninstalling, or delete `%LOCALAPPDATA%\SpeakerForDiscord\` afterwards. You can also
revoke access in Discord under *User Settings → Authorized Apps*.
