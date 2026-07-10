import { describe, expect, it } from "vitest";
import {
  parseHandshakeClientMessage,
  parseHandshakeServerMessage,
  parseHelperMessage,
  parsePluginMessage,
} from "../src/messages";
import { sessionNonce } from "../src/session-key";

const SNOWFLAKE = "123456789012345678"; // placeholder, not a real application
const NONCE = sessionNonce();

describe("parsePluginMessage field validation", () => {
  it("accepts a valid setCredentials with a secret", () => {
    expect(
      parsePluginMessage(
        JSON.stringify({
          type: "setCredentials",
          clientId: SNOWFLAKE,
          clientSecret: "s3cret",
          userInitiated: true,
        }),
      ),
    ).toEqual({
      type: "setCredentials",
      clientId: SNOWFLAKE,
      clientSecret: "s3cret",
      userInitiated: true,
    });
  });

  it("accepts setCredentials WITHOUT a secret (PKCE / Public Client)", () => {
    expect(
      parsePluginMessage(
        JSON.stringify({ type: "setCredentials", clientId: SNOWFLAKE, userInitiated: false }),
      ),
    ).toEqual({ type: "setCredentials", clientId: SNOWFLAKE, userInitiated: false });
  });

  it("normalizes an empty-string secret to absent", () => {
    const msg = parsePluginMessage(
      JSON.stringify({
        type: "setCredentials",
        clientId: SNOWFLAKE,
        clientSecret: "",
        userInitiated: false,
      }),
    );
    expect(msg).toEqual({ type: "setCredentials", clientId: SNOWFLAKE, userInitiated: false });
  });

  it("rejects a non-snowflake clientId (was written straight to auth.json)", () => {
    for (const clientId of ["", "abc", "123", "x".repeat(5_000_000), 12345, null, { a: 1 }]) {
      expect(
        parsePluginMessage(JSON.stringify({ type: "setCredentials", clientId, userInitiated: true })),
      ).toBeNull();
    }
  });

  it("rejects an oversized secret", () => {
    expect(
      parsePluginMessage(
        JSON.stringify({
          type: "setCredentials",
          clientId: SNOWFLAKE,
          clientSecret: "x".repeat(201),
          userInitiated: true,
        }),
      ),
    ).toBeNull();
  });

  it("requires userInitiated to be an explicit boolean", () => {
    // The consent modal is gated on this flag; a missing/coerced value must not pass.
    expect(
      parsePluginMessage(JSON.stringify({ type: "setCredentials", clientId: SNOWFLAKE })),
    ).toBeNull();
    expect(
      parsePluginMessage(
        JSON.stringify({ type: "setCredentials", clientId: SNOWFLAKE, userInitiated: "true" }),
      ),
    ).toBeNull();
  });

  it("parses the no-field commands, including forgetCredentials", () => {
    for (const type of ["getState", "reauthorize", "forgetCredentials", "shutdown"]) {
      expect(parsePluginMessage(JSON.stringify({ type }))).toEqual({ type });
    }
  });

  it("rejects handshake frames — they must never reach the app parser", () => {
    expect(parsePluginMessage(JSON.stringify({ type: "clientAuth", clientProof: "x" }))).toBeNull();
    expect(
      parsePluginMessage(JSON.stringify({ type: "clientChallenge", clientNonce: NONCE })),
    ).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(parsePluginMessage("not json{")).toBeNull();
    expect(parsePluginMessage(JSON.stringify(["array"]))).toBeNull();
    expect(parsePluginMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
  });
});

describe("handshake parsers are narrow", () => {
  it("server parser accepts only hello/serverAuth", () => {
    expect(
      parseHandshakeServerMessage(JSON.stringify({ type: "hello", protocolVersion: 2, serverNonce: NONCE })),
    ).toEqual({ type: "hello", protocolVersion: 2, serverNonce: NONCE });
    expect(parseHandshakeServerMessage(JSON.stringify({ type: "serverAuth", serverProof: "abc" }))).toEqual(
      { type: "serverAuth", serverProof: "abc" },
    );
    // Application frames must not come back from the handshake parser.
    expect(parseHandshakeServerMessage(JSON.stringify({ type: "speaker", speaker: null }))).toBeNull();
    expect(parseHandshakeServerMessage(JSON.stringify({ type: "welcome", pid: 1 }))).toBeNull();
  });

  it("server parser rejects a hello with a bad nonce or missing version", () => {
    expect(
      parseHandshakeServerMessage(JSON.stringify({ type: "hello", protocolVersion: 2, serverNonce: "sh" })),
    ).toBeNull();
    expect(parseHandshakeServerMessage(JSON.stringify({ type: "hello", serverNonce: NONCE }))).toBeNull();
  });

  it("client parser accepts only clientChallenge/clientAuth and bounds the proof", () => {
    expect(
      parseHandshakeClientMessage(JSON.stringify({ type: "clientChallenge", clientNonce: NONCE })),
    ).toEqual({ type: "clientChallenge", clientNonce: NONCE });
    expect(parseHandshakeClientMessage(JSON.stringify({ type: "clientAuth", clientProof: "p" }))).toEqual({
      type: "clientAuth",
      clientProof: "p",
    });
    expect(
      parseHandshakeClientMessage(JSON.stringify({ type: "clientAuth", clientProof: "x".repeat(129) })),
    ).toBeNull();
    expect(
      parseHandshakeClientMessage(
        JSON.stringify({ type: "setCredentials", clientId: SNOWFLAKE, userInitiated: true }),
      ),
    ).toBeNull();
  });
});

describe("parseHelperMessage", () => {
  it("validates welcome", () => {
    expect(
      parseHelperMessage(
        JSON.stringify({ type: "welcome", helperVersion: "1.0.0", buildId: "h-abc", pid: 42 }),
      ),
    ).toEqual({ type: "welcome", helperVersion: "1.0.0", buildId: "h-abc", pid: 42 });
    expect(parseHelperMessage(JSON.stringify({ type: "welcome", pid: "42" }))).toBeNull();
  });

  it("rejects handshake frames and unknown types", () => {
    expect(parseHelperMessage(JSON.stringify({ type: "hello", protocolVersion: 2 }))).toBeNull();
    expect(parseHelperMessage(JSON.stringify({ type: "serverAuth", serverProof: "x" }))).toBeNull();
    expect(parseHelperMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
  });

  it("passes through state messages", () => {
    const msg = parseHelperMessage(JSON.stringify({ type: "speaker", speaker: null, speakingCount: 0 }));
    expect(msg?.type).toBe("speaker");

    const channel = parseHelperMessage(
      JSON.stringify({
        type: "channel",
        channelId: "c1",
        guildId: "g1",
        guildIconUrl: "https://cdn.discordapp.com/icons/g1/h.png?size=128",
        channelName: "General",
        members: [],
      }),
    );
    expect(channel).toMatchObject({
      type: "channel",
      guildIconUrl: "https://cdn.discordapp.com/icons/g1/h.png?size=128",
    });
  });
});
