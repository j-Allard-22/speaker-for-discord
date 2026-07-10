# Creating your Discord application

The plugin talks to your local Discord client through its RPC interface. Reading
"who is speaking" needs the `rpc.voice.read` scope, which Discord gates behind approval —
**except for the application's own owner.**

So **every user registers their own application.** It takes ~3 minutes, it's free, no
approval is required, and it never joins a server. You end up as the owner of a private
app that only you use.

> The Developer Portal also lets you invite up to 50 "testers" who may use *your* app.
> That's useful for a handful of friends, but it is **not** a way to distribute the
> plugin — anyone else should make their own app instead.

## Steps

1. Open <https://discord.com/developers/applications> (sign in with the Discord account
   you use for voice chat) → **New Application** → name it (e.g. `Speaker Key`) → **Create**.

2. On **General Information**, copy the **Application ID**. That is your **Client ID**.

3. Go to the **OAuth2** tab and turn on **Public Client**.

   This lets the plugin authenticate with **PKCE** and no client secret — so no secret is
   ever stored on your machine, kept in Stream Deck's settings, or sent over the local
   socket. It is the recommended setup.

   *If you'd rather not:* leave it off, press **Reset Secret**, copy the secret (shown
   once) and paste it into the plugin's **Client Secret** field later. Never put it in a
   file in this repository.

   > ⚠️ **Pick one — don't leave both off.** Discord will happily complete the *first*
   > sign-in with PKCE and no secret even when Public Client is off, but it then refuses
   > to **refresh** the token (`401 invalid_client`). Your key would work for about seven
   > days and then ask you to authorize again. So either turn **Public Client on**, or
   > supply a **Client Secret**. The plugin tells you which is missing if this happens.

4. Still on **OAuth2**, find **Redirects** and add exactly:

   ```
   http://127.0.0.1
   ```

   → **Save Changes**. Nothing ever listens on that address — the RPC flow hands the
   authorization code back over a local pipe — but Discord requires the token exchange to
   cite a registered redirect URI verbatim.

5. If the app page shows an **RPC Origins** field, add `http://127.0.0.1` there too.
   If there's no such field, skip this.

6. **Do not create a Bot user.** This app never joins servers. If a bot already exists,
   make sure **Public Bot** is switched **OFF**.

7. *(Optional)* If you want a privacy policy on file for the app, you can point it at
   this project's [PRIVACY.md](../PRIVACY.md).

## Connect it to the plugin

8. In Stream Deck, click the **Current Speaker** key → paste **Client ID** (and the
   secret only if you skipped step 3) → the settings save automatically.

9. Discord — running, and signed into the owner account — pops an authorization dialog.
   Click **Authorize**. This happens **once**; the token is cached and refreshed silently.

## Troubleshooting

- **No dialog appears.** Make sure the Discord *desktop* app is running (not the browser)
  and you're signed into the account that owns the app. Then press **Re-authorize**.
- **"Discord rejected the token exchange."** Public Client is off and no secret was
  given. Turn on Public Client, or paste the Client Secret.
- **Key shows "Authorize" again after about a week.** The plugin could not refresh your
  token. Almost always: *Public Client* is off **and** no Client Secret was supplied. The
  key settings will say so. Turn on Public Client (step 3) or paste the secret, then press
  **Re-authorize** once.
- **Key shows "Authorize" at some other time.** The token was revoked (Discord → *User
  Settings → Authorized Apps*). Press **Re-authorize**.
- **Changed the Client ID?** Tokens belonging to the old app are wiped automatically;
  you'll authorize once more.
