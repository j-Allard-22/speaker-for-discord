import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AvatarCache, isAllowedAvatarUrl } from "../src/render/avatar-cache";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dsd-avatars-"));
}

describe("S9 regression: avatar URLs are host-pinned (no SSRF)", () => {
  it("accepts only https cdn.discordapp.com", () => {
    expect(isAllowedAvatarUrl("https://cdn.discordapp.com/avatars/1/abc.png?size=128")).toBe(true);
    expect(isAllowedAvatarUrl("https://cdn.discordapp.com/embed/avatars/3.png")).toBe(true);
  });

  it("rejects other hosts, schemes, and lookalikes", () => {
    for (const url of [
      "http://cdn.discordapp.com/avatars/1/a.png", // plain http
      "https://cdn.discordapp.com.evil.test/a.png", // suffix lookalike
      "https://evil.test/a.png",
      "https://127.0.0.1:39642/a.png", // loopback pivot
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "file:///C:/Windows/win.ini",
      "not a url",
      "",
    ]) {
      expect(isAllowedAvatarUrl(url), url).toBe(false);
    }
  });

  it("never fetches a disallowed URL and writes nothing to disk", async () => {
    const dir = tmp();
    const fetchFn = vi.fn();
    const cache = new AvatarCache(dir, fetchFn as unknown as typeof fetch);
    const result = await cache.get("http://169.254.169.254/latest/meta-data/", "1-abc");
    expect(result).toBeNull(); // caller falls back to the initials key
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("fetches and caches an allowed URL", async () => {
    const dir = tmp();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchFn = vi.fn(async () => new Response(png, { status: 200 }));
    const cache = new AvatarCache(dir, fetchFn as unknown as typeof fetch);
    const url = "https://cdn.discordapp.com/avatars/1/abc.png?size=128";

    expect(await cache.get(url, "1-abc")).toBe(png.toString("base64"));
    expect(await cache.get(url, "1-abc")).toBe(png.toString("base64")); // memory hit
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual(["1-abc.png"]);
  });

  it("refuses to follow redirects (redirect:error closes the open-redirect SSRF)", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error"); // a 3xx off the CDN must fail closed, not chase
      return new Response(Buffer.from([1]), { status: 200 });
    });
    const cache = new AvatarCache(tmp(), fetchFn as unknown as typeof fetch);
    await cache.get("https://cdn.discordapp.com/avatars/1/a.png", "1-a");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("negative-caches a failed fetch", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 }));
    const cache = new AvatarCache(tmp(), fetchFn as unknown as typeof fetch);
    const url = "https://cdn.discordapp.com/avatars/1/gone.png";
    expect(await cache.get(url, "1-gone")).toBeNull();
    expect(await cache.get(url, "1-gone")).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1); // second call served from the negative cache
  });
});
