import { describe, expect, it, vi } from "vitest";

// The action class needs only the SingletonAction shell — no Stream Deck connection.
vi.mock("@elgato/streamdeck", () => ({
  action: () => (target: unknown) => target,
  SingletonAction: class {
    get actions(): unknown[] {
      return [];
    }
  },
}));

import { CurrentSpeaker, deriveKey } from "../src/actions/current-speaker";
import { SpeakerStore, type SpeakerStoreState } from "../src/helper-client";
import { AvatarCache } from "../src/render/avatar-cache";
import { IDLE_KEY } from "../src/render/states";

const ICON_URL = "https://cdn.discordapp.com/icons/100000000000000001/hash.png?size=128";

/** Full state (deriveKey checks e.g. fatalError !== null, so partials would misroute). */
function subscribedState(over: Partial<SpeakerStoreState>): SpeakerStoreState {
  const store = new SpeakerStore();
  store.patch({ helper: "connected", status: "subscribed", ...over });
  return store.state;
}

function speakerA() {
  return {
    userId: "1",
    displayName: "Alice",
    avatarUrl: "https://cdn.discordapp.com/avatars/1/ah.png?size=128",
  };
}

/** Minimal KeyAction stand-in; records every painted image. */
function fakeKey() {
  const images: string[] = [];
  return {
    id: "key1",
    isKey: () => true,
    setTitle: async () => undefined,
    setImage: async (s: string) => {
      images.push(s);
    },
    images,
  };
}

describe("deriveKey idle branch", () => {
  it("idle with a guild icon is a dynamic key whose sig carries the URL", () => {
    const d = deriveKey(subscribedState({ speaker: null, guildIconUrl: ICON_URL }));
    expect(d.staticSvg).toBeNull();
    expect(d.guildIconUrl).toBe(ICON_URL);
    expect(d.sig).toBe(`idle:${ICON_URL}`); // icon change -> sig change -> repaint
  });

  it("idle without a guild icon stays the static dim-mic key", () => {
    const d = deriveKey(subscribedState({ speaker: null, guildIconUrl: null }));
    expect(d.staticSvg).toBe(IDLE_KEY);
    expect(d.sig).toBe("idle");
  });
});

describe("paint race: stale idle-icon fetch vs resumed speaker", () => {
  it("a superseded idle paint must not overwrite the speaker who resumed talking", async () => {
    const getSpy = vi.spyOn(AvatarCache.prototype, "get");
    getSpy.mockResolvedValueOnce("AVATAR"); // paint #1: speaker avatar, instant
    let releaseIcon!: (b64: string | null) => void; // paint #2: idle icon, slow CDN fetch
    getSpy.mockImplementationOnce(() => new Promise((r) => (releaseIcon = r)));

    const store = new SpeakerStore();
    const cs = new CurrentSpeaker(store) as unknown as {
      paint(a: ReturnType<typeof fakeKey>): Promise<void>;
    };
    const key = fakeKey();

    // 1. Alice is talking; her key commits.
    store.patch(subscribedState({ speaker: speakerA(), guildIconUrl: ICON_URL }));
    await cs.paint(key);
    expect(key.images).toHaveLength(1);
    expect(key.images[0]).toContain("AVATAR");

    // 2. Idle hold fires; the idle paint starts and hangs on a cold icon fetch.
    store.patch({ speaker: null });
    const stalePaint = cs.paint(key);

    // 3. Alice resumes BEFORE the fetch lands — same sig as the committed key, so
    //    this paint dedups... but it must still cancel the in-flight idle paint.
    store.patch({ speaker: speakerA() });
    await cs.paint(key);

    // 4. The slow fetch finally resolves. The stale idle paint must be discarded.
    releaseIcon("ICON");
    await stalePaint;
    expect(key.images).toHaveLength(1); // nothing painted over Alice
    getSpy.mockRestore();
  });

  it("a current idle paint renders the dimmed icon, and falls back to the mic on fetch failure", async () => {
    const getSpy = vi.spyOn(AvatarCache.prototype, "get");
    getSpy.mockResolvedValueOnce("ICON").mockResolvedValueOnce(null);

    const store = new SpeakerStore();
    const cs = new CurrentSpeaker(store) as unknown as {
      paint(a: ReturnType<typeof fakeKey>): Promise<void>;
    };
    const key = fakeKey();

    store.patch(subscribedState({ speaker: null, guildIconUrl: ICON_URL }));
    await cs.paint(key);
    expect(decodeURIComponent(key.images[0]!)).toContain("rgba(0,0,0,0.55)"); // dimmed icon

    // Icon changes (new hash) but the CDN fetch fails -> dim-mic fallback.
    store.patch({ guildIconUrl: ICON_URL.replace("hash", "hash2") });
    await cs.paint(key);
    expect(decodeURIComponent(key.images[1]!)).toContain(IDLE_KEY.slice(0, 40));
    getSpy.mockRestore();
  });
});
