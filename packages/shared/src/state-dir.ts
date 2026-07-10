import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HELPER_STATE_DIRNAME } from "./constants.js";

/**
 * All helper runtime state (auth.json, session.key, helper.log, avatar cache) lives
 * here — NEVER inside the .sdPlugin folder, where open Windows file handles would
 * block plugin updates and `streamdeck pack` would ship the caches.
 *
 * Confidentiality of session.key and auth.json rests on this directory's inherited
 * ACL: a Windows user profile denies other non-admin users. (The `mode` argument to
 * writeFileSync is inert on Windows, so the ACL is the control, not the mode bits.)
 *
 * Both processes must resolve the SAME path — the helper inherits the plugin's env,
 * so LOCALAPPDATA matches. Defined once here so the two sides can never drift.
 */
export function helperStateDir(): string {
  const base = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  const dir = join(base, HELPER_STATE_DIRNAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}
