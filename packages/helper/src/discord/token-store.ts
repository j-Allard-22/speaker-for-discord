/**
 * Persists OAuth tokens (plus the credentials the helper needs to boot-auth on its
 * own) at %LOCALAPPDATA%\SpeakerForDiscord\auth.json — outside the .sdPlugin
 * folder so pack/uninstall never ships or deletes it.
 *
 * Plaintext-on-disk is accepted for this personal-use tool (matches Stream Deck's
 * own unencrypted settings posture); DPAPI is a possible future hardening.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helperStateDir } from "@dsd/shared";

const MAX_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // defensive clamp; Discord's is 7 days
const EXPIRY_SAFETY_MS = 60_000;

export interface StoredAuth {
  clientId: string;
  /**
   * Absent when the user's Discord app has the Public Client flag: the OAuth flow then
   * runs on PKCE alone and no secret exists anywhere (settings, socket, or disk).
   */
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms, already includes the safety margin. */
  expiresAt?: number;
  scopes?: string;
}

export class TokenStore {
  private readonly file: string;
  private readonly tmp: string;

  constructor(dir: string = helperStateDir()) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "auth.json");
    this.tmp = this.file + ".tmp";
    // A leftover .tmp means a previous save crashed mid-write; discard it.
    try {
      rmSync(this.tmp, { force: true });
    } catch {
      /* best effort */
    }
  }

  load(): StoredAuth | null {
    if (!existsSync(this.file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoredAuth;
      if (typeof parsed.clientId !== "string") throw new Error("missing clientId");
      // A non-string secret is dropped rather than rejecting the whole record.
      if (parsed.clientSecret !== undefined && typeof parsed.clientSecret !== "string") {
        delete parsed.clientSecret;
      }
      return parsed;
    } catch {
      // Corrupt file → delete, start clean.
      try {
        rmSync(this.file, { force: true });
      } catch {
        /* best effort */
      }
      return null;
    }
  }

  private lastWritten: string | null = null;

  /** Atomic: write .tmp then rename over the real file. No-op for identical content
   * (a repeated setCredentials once hammered this file ~900x/second). */
  save(auth: StoredAuth): void {
    const serialized = JSON.stringify(auth, null, 2);
    if (serialized === this.lastWritten) return;
    writeFileSync(this.tmp, serialized);
    renameSync(this.tmp, this.file);
    this.lastWritten = serialized;
  }

  clear(): void {
    this.lastWritten = null;
    try {
      rmSync(this.file, { force: true });
    } catch {
      /* best effort */
    }
  }

  /**
   * Reconcile stored state with (possibly new) credentials. If the clientId changed,
   * stored tokens belong to another app — wipe them. Tokens belong to the *app*, not
   * the secret, so adding/removing a secret for the same clientId keeps them.
   */
  applyCredentials(clientId: string, clientSecret?: string): StoredAuth {
    const existing = this.load();
    if (existing && existing.clientId === clientId) {
      const updated: StoredAuth = { ...existing };
      if (clientSecret) updated.clientSecret = clientSecret;
      else delete updated.clientSecret;
      this.save(updated);
      return updated;
    }
    const fresh: StoredAuth = { clientId, ...(clientSecret ? { clientSecret } : {}) };
    this.save(fresh);
    return fresh;
  }

  /** Persist a token response, rotating the refresh token (keep old if omitted). */
  saveTokens(
    base: StoredAuth,
    tokens: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string },
    now: number = Date.now(),
  ): StoredAuth {
    const expiresInMs = Math.min(Math.max((tokens.expires_in ?? 0) * 1000, 0), MAX_EXPIRY_MS);
    const updated: StoredAuth = {
      ...base,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? base.refreshToken,
      expiresAt: now + expiresInMs - EXPIRY_SAFETY_MS,
      scopes: tokens.scope ?? base.scopes,
    };
    this.save(updated);
    return updated;
  }
}
