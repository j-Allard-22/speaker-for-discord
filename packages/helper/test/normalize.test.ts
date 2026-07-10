import { describe, expect, it } from "vitest";
import { camelToSnake, normalizeKeys } from "../src/discord/normalize";

describe("normalizeKeys", () => {
  it("converts camelCase keys to snake_case recursively", () => {
    expect(
      normalizeKeys({
        userId: "1",
        voiceStates: [{ userId: "2", globalName: "Jo", user: { avatarHash: "abc" } }],
      }),
    ).toEqual({
      user_id: "1",
      voice_states: [{ user_id: "2", global_name: "Jo", user: { avatar_hash: "abc" } }],
    });
  });

  it("leaves snake_case and scalars untouched", () => {
    expect(normalizeKeys({ user_id: "1", nick: null, n: 3, ok: true })).toEqual({
      user_id: "1",
      nick: null,
      n: 3,
      ok: true,
    });
    expect(normalizeKeys("channelId")).toBe("channelId"); // values are not keys
  });

  it("normalizes a realistic mixed-casing SPEAKING_START dispatch", () => {
    // The documented client bug: payload fields may arrive camelCase.
    expect(
      normalizeKeys({ cmd: "DISPATCH", evt: "SPEAKING_START", data: { userId: "53908232506183680", channelId: "9" } }),
    ).toEqual({
      cmd: "DISPATCH",
      evt: "SPEAKING_START",
      data: { user_id: "53908232506183680", channel_id: "9" },
    });
  });

  it("camelToSnake handles digit boundaries", () => {
    expect(camelToSnake("expiresIn")).toBe("expires_in");
    expect(camelToSnake("already_snake")).toBe("already_snake");
    expect(camelToSnake("v2Endpoint")).toBe("v2_endpoint");
  });
});
