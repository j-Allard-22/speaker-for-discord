# Security

## Reporting a vulnerability

Please open a [private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository rather than a public issue.

## Design notes

**The helper's localhost socket is authenticated.** The helper listens on
`127.0.0.1:39642` only. That address is reachable by any local process — including one
running as a *different* non-administrator user, since the loopback stack is not
user-isolated — and by any web page you visit, because browsers may open `ws://`
connections cross-origin with no CORS preflight. Therefore:

- **Mutual proof-of-possession.** Both sides share a random 32-byte key stored at
  `%LOCALAPPDATA%\SpeakerForDiscord\session.key` (readable only by your Windows user).
  The handshake is:

  ```
  helper → plugin   hello{serverNonce}                 (no state, not even the helper pid)
  plugin → helper   clientChallenge{clientNonce}
  helper → plugin   serverAuth{ HMAC(key,"S:"+sn+":"+cn) }
  plugin → helper   clientAuth{ HMAC(key,"C:"+sn+":"+cn) }   ← only after verifying the above
  helper → plugin   welcome + state snapshot
  ```

  The **server proves possession first**, bound to a nonce the plugin just chose. A
  process that squats the port therefore cannot obtain the plugin's Discord credentials,
  and cannot be replayed against. The distinct `"S:"`/`"C:"` domain tags prevent a
  key-less peer from reflecting the client's own proof back as the server's.

- **No state before authentication.** Voice-channel rosters, speaker updates and the
  helper's pid are released only after the client proves possession.

- **Browsers are rejected at the upgrade.** Any WebSocket upgrade carrying an `Origin`
  header is refused. This is defence in depth — the HMAC handshake is the real control,
  since a native process sends no `Origin`.

- **Bounded.** 64 KiB max frame, at most 4 concurrent clients, and unauthenticated
  sockets are terminated after 3 seconds.

**Credentials.** Enabling *Public Client* on your Discord application means the plugin
uses PKCE and **no client secret exists anywhere** — not in Stream Deck's settings, not
on the socket, not on disk. (Discord will complete the first PKCE sign-in without a
secret even if Public Client is off, but it then refuses to refresh the token; the plugin
detects this and says so.) If you supply a secret instead, it is stored in
`%LOCALAPPDATA%\SpeakerForDiscord\auth.json`, protected by your user profile's ACL, and
is redacted from all logs. `auth.json` is not encrypted at rest: an attacker already
running code as you can call DPAPI just as easily, and the profile ACL already excludes
other users. Use **Forget credentials** in the key settings to erase it.

**Consent.** Discord's authorization dialog is only ever triggered by an explicit action
you take in the property inspector — never automatically on start-up or reconnect.

**Network.** The plugin contacts only `discord.com/api/oauth2/token` and
`cdn.discordapp.com` (avatar URLs are host-pinned). There is no telemetry.

## Threat model

Out of scope: an attacker who is already executing code as your Windows user. Such an
attacker can read `session.key`, `auth.json`, and Discord's own token store directly.
