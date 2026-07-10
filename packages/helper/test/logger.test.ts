import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperLogger, redact, resolveLogLevel } from "../src/logger";

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

  it("scrubs our OWN camelCase storage keys, not just Discord's wire casing", () => {
    // A StoredAuth object logged anywhere must not leak. The camelCase variants were
    // missing from the regex — a latent plaintext-secret leak.
    const logger = new HelperLogger({
      dir: mkdtempSync(join(tmpdir(), "dsd-log-")),
      mirrorToConsole: false,
    });
    const line = logger.format("info", "stored auth", {
      clientId: "123456789012345678",
      clientSecret: "SECRET_VALUE",
      accessToken: "ACCESS_VALUE",
      refreshToken: "REFRESH_VALUE",
      expiresAt: 123,
    });
    expect(line).not.toContain("SECRET_VALUE");
    expect(line).not.toContain("ACCESS_VALUE");
    expect(line).not.toContain("REFRESH_VALUE");
    expect(line).toContain("123456789012345678"); // clientId is not a secret
  });

  it("also scrubs the PKCE code_verifier", () => {
    const logger = new HelperLogger({ dir: mkdtempSync(join(tmpdir(), "dsd-log-")), mirrorToConsole: false });
    expect(logger.format("debug", "exchange", { code_verifier: "VERIFIER_VALUE" })).not.toContain(
      "VERIFIER_VALUE",
    );
  });
});

describe("level filtering", () => {
  it("defaults to info: debug lines are NOT written to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsd-log-"));
    const logger = new HelperLogger({ dir, mirrorToConsole: false });
    expect(logger.debugEnabled).toBe(false);
    logger.debug("rpc send", { cmd: "SUBSCRIBE", args: { channel_id: "1225170212668706827" } });
    logger.info("status", { discord: "subscribed" });

    const contents = existsSync(join(dir, "helper.log"))
      ? readFileSync(join(dir, "helper.log"), "utf8")
      : "";
    expect(contents).not.toContain("1225170212668706827"); // no channel IDs at info
    expect(contents).toContain("status");
  });

  it("debug level opts in", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsd-log-"));
    const logger = new HelperLogger({ dir, mirrorToConsole: false, minLevel: "debug" });
    expect(logger.debugEnabled).toBe(true);
    logger.debug("rpc send", { cmd: "SUBSCRIBE" });
    expect(readFileSync(join(dir, "helper.log"), "utf8")).toContain("SUBSCRIBE");
  });

  it("error level suppresses warn and below", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsd-log-"));
    const logger = new HelperLogger({ dir, mirrorToConsole: false, minLevel: "error" });
    logger.warn("nope");
    logger.error("yep");
    const contents = readFileSync(join(dir, "helper.log"), "utf8");
    expect(contents).not.toContain("nope");
    expect(contents).toContain("yep");
  });

  it("resolveLogLevel falls back to info for junk", () => {
    expect(resolveLogLevel("debug")).toBe("debug");
    expect(resolveLogLevel("error")).toBe("error");
    expect(resolveLogLevel(undefined)).toBe("info");
    expect(resolveLogLevel("verbose")).toBe("info");
  });
});
