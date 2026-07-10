import { describe, expect, it } from "vitest";
import { DEFAULT_HELPER_PORT, MAX_PAYLOAD_BYTES, PROTOCOL_VERSION } from "@dsd/shared";

/** Protocol parsing is covered in packages/shared/test/messages.test.ts. */
describe("shared constants reach the helper package", () => {
  it("exposes sane values", () => {
    expect(PROTOCOL_VERSION).toBe(2); // v2 = mutual-auth handshake
    expect(DEFAULT_HELPER_PORT).toBeGreaterThan(1024);
    expect(MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(64 * 1024); // not ws's 100 MiB default
  });
});
