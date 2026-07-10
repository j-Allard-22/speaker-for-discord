/**
 * Per-machine shared secret + mutual proof-of-possession for the localhost link.
 *
 * WHY: the helper's WebSocket listens on 127.0.0.1, which is reachable by (a) any web
 * page the user visits — browsers open ws:// cross-origin with no CORS preflight — and
 * (b) any local process, including one running as a *different* non-admin user, since
 * the loopback stack is not user-isolated. Without authentication such a peer can read
 * the user's live voice-channel roster, and a peer that squats the port before the
 * helper can impersonate it and receive the user's Discord credentials.
 *
 * The key file lives in the user's %LOCALAPPDATA% (see state-dir.ts): browsers cannot
 * read files at all, and other non-admin users cannot read another user's profile. A
 * same-user attacker defeats this — but such an attacker can already read auth.json,
 * so it is outside the threat model.
 *
 * PROOF CONSTRUCTION — both parts are load-bearing:
 *
 *   serverProof = HMAC(key, "S:" + serverNonce + ":" + clientNonce)
 *   clientProof = HMAC(key, "C:" + serverNonce + ":" + clientNonce)
 *
 * 1. TWO nonces. The server's proof is bound to a nonce the *client* just chose, so a
 *    squatter cannot replay a serverProof captured from a real helper.
 * 2. DOMAIN TAGS ("S:" / "C:"). Without them both proofs are byte-identical, and a
 *    key-less squatter could simply REFLECT the client's own proof back as its own —
 *    a total bypass. The 1-char prefix makes the two HMAC inputs provably distinct.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_KEY_FILENAME = "session.key";
export const SESSION_KEY_BYTES = 32;

/** Nonces are base64url — no ":" — so the tagged HMAC input is unambiguous. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export type ProofRole = "S" | "C";

/**
 * Read the key, or create it atomically if absent. `flag: "wx"` is O_CREAT|O_EXCL, so
 * exactly one of {plugin, helper} wins the create and the loser re-reads the winner's
 * key. A short/corrupt file is replaced. Callers read once at boot and cache for life:
 * the key is a local capability with no exfiltration vector, so rotation buys nothing
 * and would break an already-connected pair.
 */
export function loadOrCreateSessionKey(dir: string): Buffer {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, SESSION_KEY_FILENAME);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const buf = readFileSync(file);
      if (buf.length >= SESSION_KEY_BYTES) return buf.subarray(0, SESSION_KEY_BYTES);
      rmSync(file, { force: true }); // short/corrupt -> recreate below
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      const key = randomBytes(SESSION_KEY_BYTES);
      writeFileSync(file, key, { flag: "wx", mode: 0o600 });
      return key;
    } catch (err) {
      // EEXIST: someone created it between our read and our write — loop and re-read.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not obtain session key at ${file}`);
}

export function sessionNonce(): string {
  return randomBytes(24).toString("base64url"); // 32 chars, matches NONCE_PATTERN
}

export function isValidNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

export function sessionProof(
  key: Buffer,
  role: ProofRole,
  serverNonce: string,
  clientNonce: string,
): string {
  return createHmac("sha256", key)
    .update(`${role}:${serverNonce}:${clientNonce}`)
    .digest("base64");
}

/** Constant-time compare, guarded against the length mismatch that would make timingSafeEqual throw. */
export function verifySessionProof(
  key: Buffer,
  role: ProofRole,
  serverNonce: string,
  clientNonce: string,
  presented: unknown,
): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const expected = Buffer.from(sessionProof(key, role, serverNonce, clientNonce), "base64");
  let got: Buffer;
  try {
    got = Buffer.from(presented, "base64");
  } catch {
    return false;
  }
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}
