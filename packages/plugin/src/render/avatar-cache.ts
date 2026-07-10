/**
 * Avatar bytes as base64 PNG: memory LRU (50) -> disk -> CDN fetch (5 s abort).
 * Disk cache lives in %LOCALAPPDATA%\DiscordSpeakerHelper\avatars — the hash in the
 * filename gives natural invalidation when a user changes their avatar. Failures are
 * negative-cached for 60 s and the caller falls back to the initials key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helperStateDir } from "../helper-manager";

const MEM_CAP = 50;
const NEGATIVE_TTL_MS = 60_000;

interface MemEntry {
  b64: string | null; // null = negative entry
  expiresAt: number | null;
}

export class AvatarCache {
  private readonly mem = new Map<string, MemEntry>();
  private readonly dir: string;

  constructor(dir?: string, private readonly fetchFn: typeof fetch = fetch) {
    this.dir = dir ?? join(helperStateDir(), "avatars");
    mkdirSync(this.dir, { recursive: true });
  }

  /** cacheKey should be `${userId}-${avatarHash || "default-N"}`. */
  async get(url: string, cacheKey: string): Promise<string | null> {
    const safeKey = cacheKey.replace(/[^A-Za-z0-9_.-]/g, "_");

    const hit = this.mem.get(safeKey);
    if (hit && (hit.expiresAt === null || hit.expiresAt > Date.now())) {
      this.touch(safeKey, hit);
      return hit.b64;
    }

    const file = join(this.dir, `${safeKey}.png`);
    if (existsSync(file)) {
      try {
        const b64 = readFileSync(file).toString("base64");
        this.put(safeKey, { b64, expiresAt: null });
        return b64;
      } catch {
        /* fall through to fetch */
      }
    }

    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      try {
        writeFileSync(file, bytes);
      } catch {
        /* disk cache is best-effort */
      }
      const b64 = bytes.toString("base64");
      this.put(safeKey, { b64, expiresAt: null });
      return b64;
    } catch {
      this.put(safeKey, { b64: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
      return null;
    }
  }

  private put(key: string, entry: MemEntry): void {
    this.mem.delete(key);
    this.mem.set(key, entry);
    while (this.mem.size > MEM_CAP) {
      const oldest = this.mem.keys().next().value as string;
      this.mem.delete(oldest);
    }
  }

  private touch(key: string, entry: MemEntry): void {
    this.mem.delete(key);
    this.mem.set(key, entry);
  }
}
