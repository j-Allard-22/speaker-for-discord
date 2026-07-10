import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TokenStore } from "../src/discord/token-store";

function freshStore(): { store: TokenStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "dsd-tokens-"));
  return { store: new TokenStore(dir), dir };
}

describe("TokenStore", () => {
  it("round-trips auth state", () => {
    const { store } = freshStore();
    store.save({ clientId: "c", clientSecret: "s", accessToken: "at" });
    expect(store.load()).toEqual({ clientId: "c", clientSecret: "s", accessToken: "at" });
  });

  it("recovers from a corrupt file by deleting it", () => {
    const { store, dir } = freshStore();
    writeFileSync(join(dir, "auth.json"), "{corrupt");
    expect(store.load()).toBeNull();
    expect(store.load()).toBeNull(); // stays clean
  });

  it("wipes tokens when the clientId changes (they belong to another app)", () => {
    const { store } = freshStore();
    store.save({ clientId: "old", clientSecret: "s1", accessToken: "at", refreshToken: "rt" });
    const fresh = store.applyCredentials("new", "s2");
    expect(fresh).toEqual({ clientId: "new", clientSecret: "s2" });
    expect(store.load()?.accessToken).toBeUndefined();
  });

  it("keeps tokens when only the secret is re-entered for the same app", () => {
    const { store } = freshStore();
    store.save({ clientId: "app", clientSecret: "s1", accessToken: "at", refreshToken: "rt" });
    const kept = store.applyCredentials("app", "s2");
    expect(kept.accessToken).toBe("at");
    expect(kept.clientSecret).toBe("s2");
  });

  it("PUBLIC CLIENT: accepts a record with no clientSecret", () => {
    const { store } = freshStore();
    store.save({ clientId: "app", accessToken: "at" });
    expect(store.load()).toEqual({ clientId: "app", accessToken: "at" });
  });

  it("dropping the secret for the same app keeps the tokens (tokens belong to the app)", () => {
    const { store } = freshStore();
    store.save({ clientId: "app", clientSecret: "s", accessToken: "at", refreshToken: "rt" });
    const updated = store.applyCredentials("app"); // user enabled Public Client, cleared secret
    expect(updated.clientSecret).toBeUndefined();
    expect(updated.accessToken).toBe("at");
    expect(updated.refreshToken).toBe("rt");
    expect(store.load()?.clientSecret).toBeUndefined();
  });

  it("adding a secret later for the same app also keeps the tokens", () => {
    const { store } = freshStore();
    store.save({ clientId: "app", accessToken: "at", refreshToken: "rt" });
    const updated = store.applyCredentials("app", "s");
    expect(updated.clientSecret).toBe("s");
    expect(updated.accessToken).toBe("at");
  });

  it("drops a non-string secret rather than discarding the whole record", () => {
    const { store, dir } = freshStore();
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ clientId: "app", clientSecret: 42, accessToken: "at" }));
    const loaded = store.load();
    expect(loaded?.clientId).toBe("app");
    expect(loaded?.accessToken).toBe("at");
    expect(loaded?.clientSecret).toBeUndefined();
  });

  it("rotates the refresh token, keeping the old one if the response omits it", () => {
    const { store } = freshStore();
    const base = store.applyCredentials("app", "s");
    const now = 1_000_000;
    let auth = store.saveTokens(
      base,
      { access_token: "at1", refresh_token: "rt1", expires_in: 604_800 },
      now,
    );
    expect(auth.refreshToken).toBe("rt1");
    expect(auth.expiresAt).toBe(now + 604_800_000 - 60_000);

    // Refresh response WITHOUT a new refresh token -> keep rt1.
    auth = store.saveTokens(auth, { access_token: "at2", expires_in: 100 }, now);
    expect(auth.refreshToken).toBe("rt1");
    expect(auth.accessToken).toBe("at2");

    // Rotation: new refresh token replaces the old.
    auth = store.saveTokens(auth, { access_token: "at3", refresh_token: "rt2" }, now);
    expect(store.load()?.refreshToken).toBe("rt2");
  });

  it("clamps absurd expires_in values", () => {
    const { store } = freshStore();
    const base = store.applyCredentials("app", "s");
    const now = 0;
    const auth = store.saveTokens(
      base,
      { access_token: "at", expires_in: 10 * 365 * 24 * 60 * 60 }, // 10 years
      now,
    );
    expect(auth.expiresAt).toBe(90 * 24 * 60 * 60 * 1000 - 60_000); // clamped to 90 days
  });

  it("saves atomically via tmp+rename (no partial file visible)", () => {
    const { store, dir } = freshStore();
    store.save({ clientId: "c", clientSecret: "s" });
    // The real file parses; no .tmp remains.
    expect(() => JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))).not.toThrow();
    expect(() => readFileSync(join(dir, "auth.json.tmp"))).toThrow();
  });
});
