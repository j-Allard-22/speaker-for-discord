import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isValidNonce,
  loadOrCreateSessionKey,
  SESSION_KEY_BYTES,
  SESSION_KEY_FILENAME,
  sessionNonce,
  sessionProof,
  verifySessionProof,
} from "../src/session-key";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dsd-key-"));
}

describe("loadOrCreateSessionKey", () => {
  it("creates a 32-byte key and returns the same bytes on re-read", () => {
    const dir = tmp();
    const a = loadOrCreateSessionKey(dir);
    expect(a).toHaveLength(SESSION_KEY_BYTES);
    const b = loadOrCreateSessionKey(dir);
    expect(b.equals(a)).toBe(true); // the create-or-read race resolves to ONE key
  });

  it("regenerates a short/corrupt key file", () => {
    const dir = tmp();
    writeFileSync(join(dir, SESSION_KEY_FILENAME), Buffer.from([1, 2, 3, 4]));
    const key = loadOrCreateSessionKey(dir);
    expect(key).toHaveLength(SESSION_KEY_BYTES);
    expect(readFileSync(join(dir, SESSION_KEY_FILENAME))).toHaveLength(SESSION_KEY_BYTES);
  });

  it("two independent callers on the same dir converge (simulated wx race)", () => {
    const dir = tmp();
    // Whoever wins `flag:"wx"` keeps the key; the loser must re-read it, never overwrite.
    const first = loadOrCreateSessionKey(dir);
    const second = loadOrCreateSessionKey(dir);
    const third = loadOrCreateSessionKey(dir);
    expect(second.equals(first)).toBe(true);
    expect(third.equals(first)).toBe(true);
  });
});

describe("nonces", () => {
  it("generates base64url nonces with no ':' (keeps the tagged HMAC input unambiguous)", () => {
    for (let i = 0; i < 20; i++) {
      const n = sessionNonce();
      expect(isValidNonce(n)).toBe(true);
      expect(n).not.toContain(":");
    }
  });

  it("rejects malformed nonces", () => {
    expect(isValidNonce("")).toBe(false);
    expect(isValidNonce("short")).toBe(false);
    expect(isValidNonce("has:colon:in:it:aaaaaaaaaaaaaaaa")).toBe(false);
    expect(isValidNonce("x".repeat(65))).toBe(false);
    expect(isValidNonce(42)).toBe(false);
  });
});

describe("mutual proof-of-possession", () => {
  const key = loadOrCreateSessionKey(tmp());
  const sn = sessionNonce();
  const cn = sessionNonce();

  it("round-trips each role", () => {
    expect(verifySessionProof(key, "S", sn, cn, sessionProof(key, "S", sn, cn))).toBe(true);
    expect(verifySessionProof(key, "C", sn, cn, sessionProof(key, "C", sn, cn))).toBe(true);
  });

  it("REFLECTION REGRESSION: a client proof is not a valid server proof", () => {
    // Without the "S:"/"C:" domain tags both proofs would be byte-identical, letting a
    // key-less port-squatter reflect the client's own proof back as its server proof.
    const clientProof = sessionProof(key, "C", sn, cn);
    expect(verifySessionProof(key, "S", sn, cn, clientProof)).toBe(false);
    const serverProof = sessionProof(key, "S", sn, cn);
    expect(verifySessionProof(key, "C", sn, cn, serverProof)).toBe(false);
    expect(clientProof).not.toBe(serverProof);
  });

  it("REPLAY REGRESSION: a server proof is bound to the client's fresh nonce", () => {
    // A squatter replaying a serverProof captured from a real helper must fail once the
    // plugin picks a new clientNonce.
    const captured = sessionProof(key, "S", sn, cn);
    const freshClientNonce = sessionNonce();
    expect(verifySessionProof(key, "S", sn, freshClientNonce, captured)).toBe(false);
  });

  it("rejects a proof made with a different key", () => {
    const other = loadOrCreateSessionKey(tmp());
    expect(verifySessionProof(key, "S", sn, cn, sessionProof(other, "S", sn, cn))).toBe(false);
  });

  it("rejects swapped nonces", () => {
    expect(verifySessionProof(key, "S", cn, sn, sessionProof(key, "S", sn, cn))).toBe(false);
  });

  it("rejects garbage, empty, and wrong-length proofs without throwing", () => {
    expect(verifySessionProof(key, "S", sn, cn, "")).toBe(false);
    expect(verifySessionProof(key, "S", sn, cn, "!!!not base64!!!")).toBe(false);
    expect(verifySessionProof(key, "S", sn, cn, "AAAA")).toBe(false); // short
    expect(verifySessionProof(key, "S", sn, cn, undefined)).toBe(false);
    expect(verifySessionProof(key, "S", sn, cn, 12345)).toBe(false);
  });
});
