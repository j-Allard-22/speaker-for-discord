# Discord Developer Portal setup

The plugin talks to your local Discord client through its RPC interface. That requires a
Discord **application** you own — takes about 3 minutes, no approval process needed for
personal use (the app owner and up to 50 invited testers may use RPC without Discord's
review).

## Steps

1. Open <https://discord.com/developers/applications> (log in with the Discord account
   you'll use in voice chat) → **New Application** → name it (e.g. `Speaker Key`) → **Create**.

2. On **General Information**, copy the **Application ID**. This is your **Client ID**.

3. Go to **OAuth2** → click **Reset Secret** → copy the **Client Secret**.
   ⚠️ It is shown **once**. Paste it only into the plugin's key settings in the Stream Deck
   app — never into a file in this repository.

4. Still under **OAuth2**, find **Redirects** and add exactly:

   ```
   http://127.0.0.1
   ```

   → **Save Changes**. (Nothing ever listens on that address — the RPC flow returns the
   authorization code over a local pipe — but the token exchange must cite a registered
   redirect URI verbatim.)

5. If the app page shows an **RPC Origins** field, add `http://127.0.0.1` there too.
   If you don't see the field, skip this — it's fine.

6. **Do not create a Bot user.** This app never joins servers. If a bot already exists on
   the app, make sure **Public Bot** is switched **OFF**.

7. *(Optional — only if other people will use your build:)* open the **App Testers** page
   and invite up to 50 Discord accounts by email; each tester must accept the emailed
   invite. Unapproved apps allow RPC only for the owner + testers — exactly right for
   personal use.

## Wiring it into the plugin

8. In the Stream Deck app, click the **Current Speaker** key → the property inspector
   opens → paste **Client ID** and **Client Secret** → **Save & Connect**.

9. Discord (must be running, logged into the owner/tester account) pops an authorization
   dialog → click **Authorize**. This happens **once**; the token is cached and refreshed
   silently afterwards.

## Troubleshooting

- **No dialog appears:** make sure the Discord *desktop* app is running (not just the
  browser version) and you're logged into the account that owns the app (or a tester).
- **"Authorize" key state after a while:** tokens can be revoked (e.g. you pressed
  "Deauthorize" in Discord settings → Authorized Apps). Open the key settings and press
  **Re-authorize**.
- **Changed the Client ID?** Stored tokens belong to the old app and are wiped
  automatically; you'll be asked to authorize again.
