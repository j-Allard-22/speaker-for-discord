import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperLogger, redact } from "../src/logger";

describe("redact", () => {
  it("scrubs secret string values, keeps numeric codes", () => {
    expect(
      redact({
        access_token: "aaa",
        refresh_token: "bbb",
        client_secret: "ccc",
        code: "authcode123",
        nested: [{ token: "ddd" }],
        error: { code: 4009, message: "boom" }, // numeric RPC error code survives
        user_id: "123",
      }),
    ).toEqual({
      access_token: "[redacted]",
      refresh_token: "[redacted]",
      client_secret: "[redacted]",
      code: "[redacted]",
      nested: [{ token: "[redacted]" }],
      error: { code: 4009, message: "boom" },
      user_id: "123",
    });
  });

  it("a logged AUTHENTICATE frame contains no token substring", () => {
    const logger = new HelperLogger({
      dir: mkdtempSync(join(tmpdir(), "dsd-log-")),
      mirrorToConsole: false,
    });
    const line = logger.format("debug", "send", {
      cmd: "AUTHENTICATE",
      args: { access_token: "SUPERSECRETTOKEN" },
      nonce: "n1",
    });
    expect(line).not.toContain("SUPERSECRETTOKEN");
    expect(line).toContain("AUTHENTICATE");
  });

  it("a logged token-exchange response leaks nothing", () => {
    const logger = new HelperLogger({
      dir: mkdtempSync(join(tmpdir(), "dsd-log-")),
      mirrorToConsole: false,
    });
    const line = logger.format("debug", "token response", {
      access_token: "AT123",
      refresh_token: "RT456",
      expires_in: 604800,
      scope: "rpc rpc.voice.read",
    });
    expect(line).not.toContain("AT123");
    expect(line).not.toContain("RT456");
    expect(line).toContain("604800");
  });
});
