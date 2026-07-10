# Privacy Policy — Speaker for Discord

_Last updated: 2026-07-10_

**Speaker for Discord** is a Stream Deck plugin that runs entirely on your own computer.
It has **no servers, no accounts, and no telemetry**. Nothing you do with it is sent to
the plugin's author.

## What the plugin reads

To show who is speaking, the plugin asks your **local Discord desktop app** (over
Discord's local RPC interface) for:

- the voice channel you are currently in — its name, channel ID and guild ID;
- the members in that channel — their Discord user ID, display name (server nickname,
  global name, or username) and avatar image;
- which of them is speaking, moment to moment.

It also holds the OAuth credentials you supply (your own Discord application's Client
ID, and a Client Secret **only if** you choose not to enable Public Client), plus the
access/refresh tokens Discord issues to you.

## Where that data goes

**It stays on your computer.** The plugin makes exactly two kinds of outbound network
request, both to Discord:

| Destination | Purpose |
|---|---|
| `https://discord.com/api/oauth2/token` | Exchange/refresh your OAuth token |
| `https://cdn.discordapp.com` | Download the speaking member's avatar image |

There is no analytics, crash reporting, or any other outbound connection. The plugin's
author receives nothing.

## What is stored on your computer

Everything lives in `%LOCALAPPDATA%\SpeakerForDiscord\`:

| File | Contents |
|---|---|
| `auth.json` | Your Client ID, optional Client Secret, and Discord access/refresh tokens |
| `session.key` | A random 32-byte key used to authenticate the plugin↔helper link |
| `avatars/` | Cached avatar images of people in your voice channel |
| `helper.log` | Diagnostic log (secrets and tokens are redacted; capped at ~10 MB) |

Discord user IDs, display names, and channel names may appear in `helper.log` only when
you explicitly enable debug logging (`DSD_LOG_LEVEL=debug`). At the default level they
do not.

This folder is inside your Windows user profile, so other non-administrator accounts on
the same PC cannot read it.

## Deleting your data

- **From the plugin:** open the key's settings and press **Forget credentials**. This
  erases the stored tokens and clears the Client ID/Secret.
- **Completely:** delete the folder `%LOCALAPPDATA%\SpeakerForDiscord\`.
- **Revoke Discord's side:** Discord → *User Settings → Authorized Apps* → revoke your
  application. You may also delete the application entirely in the
  [Developer Portal](https://discord.com/developers/applications).

Uninstalling the plugin does **not** remove that folder; delete it manually if you want
the data gone.

## Other people's data

The plugin displays the names and avatars of other members of your voice channel. That
information is fetched from Discord for display on your Stream Deck and cached locally
(see above). It is never transmitted anywhere, sold, shared, or used for any other
purpose, and it is deleted along with the folder above.

## Your own Discord application

Because Discord's `rpc.voice.read` scope is approval-gated, **each user registers their
own Discord application**. That makes you the owner and data controller of that
application. You may reference this document as its privacy policy, or write your own.

## Contact

Questions or requests: open an issue on the project's GitHub repository.
