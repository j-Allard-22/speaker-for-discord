import { describe, expect, it } from "vitest";
import { DEFAULT_HELPER_PORT, PROTOCOL_VERSION, parseHelperMessage, parsePluginMessage } from "@dsd/shared";

describe("shared protocol", () => {
  it("exposes sane constants", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(DEFAULT_HELPER_PORT).toBeGreaterThan(1024);
  });

  it("parses a valid helper message", () => {
    const msg = parseHelperMessage(
      JSON.stringify({ type: "speaker", speaker: null, speakingCount: 0 }),
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("speaker");
  });

  it("rejects malformed and unknown payloads", () => {
    expect(parseHelperMessage("not json{")).toBeNull();
    expect(parseHelperMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
    expect(parseHelperMessage(JSON.stringify(["array"]))).toBeNull();
    expect(parsePluginMessage(JSON.stringify({ type: "hello" }))).toBeNull(); // wrong direction
  });
});
