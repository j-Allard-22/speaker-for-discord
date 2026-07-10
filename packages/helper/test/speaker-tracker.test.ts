import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberInfo } from "@dsd/shared";
import {
  buildAvatarUrl,
  buildGuildIconUrl,
  SpeakerTracker,
  type RawVoiceState,
} from "../src/speaker-tracker";

function vs(id: string, name: string, extra: Partial<RawVoiceState> = {}): RawVoiceState {
  return { user: { id, username: name, discriminator: "0" }, ...extra };
}

describe("buildAvatarUrl", () => {
  it("uses the custom hash when present (PNG even for animated hashes)", () => {
    expect(buildAvatarUrl("1", "a_abc", "0")).toBe(
      "https://cdn.discordapp.com/avatars/1/a_abc.png?size=128",
    );
  });
  it("legacy discriminator branch: % 5", () => {
    expect(buildAvatarUrl("1", null, "1234")).toBe(
      "https://cdn.discordapp.com/embed/avatars/4.png", // 1234 % 5
    );
  });
  it("new username system branch: (id >> 22) % 6", () => {
    expect(buildAvatarUrl(String(7n << 22n), null, "0")).toBe(
      "https://cdn.discordapp.com/embed/avatars/1.png", // 7 % 6
    );
    expect(buildAvatarUrl(String(6n << 22n), null, undefined)).toBe(
      "https://cdn.discordapp.com/embed/avatars/0.png", // 6 % 6
    );
  });
});

describe("buildGuildIconUrl", () => {
  const GID = "100000000000000001";

  it("rebuilds a valid CDN icon URL as .png with size", () => {
    expect(buildGuildIconUrl(GID, `https://cdn.discordapp.com/icons/${GID}/hash123.webp`)).toBe(
      `https://cdn.discordapp.com/icons/${GID}/hash123.png?size=128`,
    );
  });

  it("keeps animated a_ hashes (static .png frame)", () => {
    expect(buildGuildIconUrl(GID, `https://cdn.discordapp.com/icons/${GID}/a_hash.gif`)).toBe(
      `https://cdn.discordapp.com/icons/${GID}/a_hash.png?size=128`,
    );
  });

  it("fails closed on a guild-id mismatch (peer-controlled URL must not be trusted)", () => {
    expect(
      buildGuildIconUrl(GID, "https://cdn.discordapp.com/icons/200000000000000002/hash.png"),
    ).toBeNull();
  });

  it("fails closed on a non-CDN host and on protocol confusion", () => {
    expect(buildGuildIconUrl(GID, `https://evil.example.com/icons/${GID}/hash.png`)).toBeNull();
    expect(buildGuildIconUrl(GID, `http://cdn.discordapp.com/icons/${GID}/hash.png`)).toBeNull();
    expect(
      buildGuildIconUrl(GID, `https://cdn.discordapp.com.evil.example/icons/${GID}/hash.png`),
    ).toBeNull();
  });

  it("fails closed on missing input", () => {
    expect(buildGuildIconUrl(GID, null)).toBeNull();
    expect(buildGuildIconUrl(GID, undefined)).toBeNull();
    expect(buildGuildIconUrl(GID, "")).toBeNull();
  });

  it("fails closed on an oversized hash (a squatting peer can ship 16 MiB frames)", () => {
    const huge = "a".repeat(1_000_000);
    expect(buildGuildIconUrl(GID, `https://cdn.discordapp.com/icons/${GID}/${huge}.png`)).toBeNull();
    // 64 chars is the cap; 65 must fail.
    expect(
      buildGuildIconUrl(GID, `https://cdn.discordapp.com/icons/${GID}/${"a".repeat(65)}.png`),
    ).toBeNull();
    expect(
      buildGuildIconUrl(GID, `https://cdn.discordapp.com/icons/${GID}/${"a".repeat(64)}.png`),
    ).toBe(`https://cdn.discordapp.com/icons/${GID}/${"a".repeat(64)}.png?size=128`);
  });
});

describe("SpeakerTracker", () => {
  let tracker: SpeakerTracker;
  let emissions: Array<MemberInfo | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new SpeakerTracker();
    emissions = [];
    tracker.on("speaker", (s: MemberInfo | null) => emissions.push(s));
    tracker.setRoster([vs("A", "Alice"), vs("B", "Bob"), vs("C", "Carol")]);
  });
  afterEach(() => vi.useRealTimers());

  it("idle -> someone emits immediately", () => {
    tracker.speakingStart("A");
    expect(emissions.map((e) => e?.userId)).toEqual(["A"]);
  });

  it("most-recent-to-start wins after the switch debounce", () => {
    tracker.speakingStart("A");
    vi.advanceTimersByTime(10);
    tracker.speakingStart("B"); // B started later -> most recent
    expect(emissions.map((e) => e?.userId)).toEqual(["A"]); // not yet
    vi.advanceTimersByTime(250);
    expect(emissions.map((e) => e?.userId)).toEqual(["A", "B"]);
  });

  it("switch debounce swallows A/B flapping", () => {
    tracker.speakingStart("A");
    vi.advanceTimersByTime(10);
    tracker.speakingStart("B"); // pending switch to B
    vi.advanceTimersByTime(100);
    tracker.speakingStop("B"); // back to A before the 250 ms fires
    vi.advanceTimersByTime(1000);
    expect(emissions.map((e) => e?.userId)).toEqual(["A"]); // B never shown
  });

  it("idle hold bridges VAD gaps between phrases", () => {
    tracker.speakingStart("A");
    tracker.speakingStop("A");
    vi.advanceTimersByTime(1400); // still holding
    expect(emissions.map((e) => e?.userId)).toEqual(["A"]);
    tracker.speakingStart("A"); // resumes within the hold -> no idle flash
    vi.advanceTimersByTime(2000);
    expect(emissions.map((e) => e?.userId)).toEqual(["A"]);
    tracker.speakingStop("A");
    vi.advanceTimersByTime(1500);
    expect(emissions).toEqual([expect.objectContaining({ userId: "A" }), null]);
  });

  it("discards ghost SPEAKING_START for users not in the roster", () => {
    tracker.speakingStart("GHOST");
    vi.advanceTimersByTime(2000);
    expect(emissions).toEqual([]);
    expect(tracker.speakingCount).toBe(0);
  });

  it("VOICE_STATE_DELETE of the active speaker leads to idle (via hold)", () => {
    tracker.speakingStart("A");
    tracker.removeMember("A");
    vi.advanceTimersByTime(1500);
    expect(emissions).toEqual([expect.objectContaining({ userId: "A" }), null]);
    expect(tracker.memberList.map((m) => m.userId)).toEqual(["B", "C"]);
  });

  it("re-emits immediately when the CURRENT speaker's identity changes mid-speech", () => {
    tracker.speakingStart("A");
    tracker.upsertMember({ ...vs("A", "Alice"), nick: "Ali🎤" });
    expect(emissions.map((e) => e?.displayName)).toEqual(["Alice", "Ali🎤"]);
  });

  it("clear() goes idle immediately — never a stale speaker", () => {
    tracker.speakingStart("A");
    tracker.clear();
    expect(emissions).toEqual([expect.objectContaining({ userId: "A" }), null]);
    expect(tracker.memberList).toEqual([]);
  });

  it("display name precedence: nick > global_name > username", () => {
    tracker.setRoster([
      { user: { id: "1", username: "u1", global_name: "G1" }, nick: "N1" },
      { user: { id: "2", username: "u2", global_name: "G2" } },
      { user: { id: "3", username: "u3" } },
    ]);
    expect(tracker.memberList.map((m) => m.displayName)).toEqual(["N1", "G2", "u3"]);
  });

  it("setRoster drops speaking entries for vanished users", () => {
    tracker.speakingStart("A");
    tracker.speakingStart("B");
    tracker.setRoster([vs("B", "Bob")]);
    expect(tracker.speakingCount).toBe(1);
  });
});
