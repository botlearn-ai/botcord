import { describe, it, expect } from "vitest";
import { createPublicKey, createPrivateKey, verify } from "node:crypto";
import {
  jcsCanonicalize,
  computePayloadHash,
  signChallenge,
  buildSignedEnvelope,
  generateKeypair,
} from "../crypto.js";

// ── Helper: derive public key from private seed ──────────────────
function pubKeyFromSeed(seedB64: string) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const pk = createPrivateKey({
    key: Buffer.concat([prefix, Buffer.from(seedB64, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(pk);
}

// ── jcsCanonicalize ──────────────────────────────────────────────

describe("jcsCanonicalize", () => {
  it("canonicalizes primitives", () => {
    expect(jcsCanonicalize(null)).toBe("null");
    expect(jcsCanonicalize(true)).toBe("true");
    expect(jcsCanonicalize(false)).toBe("false");
    expect(jcsCanonicalize(42)).toBe("42");
    expect(jcsCanonicalize("hello")).toBe('"hello"');
  });

  it("treats -0 as 0", () => {
    expect(jcsCanonicalize(-0)).toBe("0");
  });

  it("returns undefined for undefined", () => {
    expect(jcsCanonicalize(undefined)).toBeUndefined();
  });

  it("canonicalizes arrays", () => {
    expect(jcsCanonicalize([1, "a", true])).toBe('[1,"a",true]');
  });

  it("sorts object keys alphabetically", () => {
    expect(jcsCanonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("omits undefined values in objects", () => {
    expect(jcsCanonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("handles nested objects with sorted keys", () => {
    const input = { z: { y: 1, x: 2 }, a: [3, 4] };
    expect(jcsCanonicalize(input)).toBe('{"a":[3,4],"z":{"x":2,"y":1}}');
  });

  it("handles empty object and array", () => {
    expect(jcsCanonicalize({})).toBe("{}");
    expect(jcsCanonicalize([])).toBe("[]");
  });
});

// ── computePayloadHash ──────────────────────────────────────────

describe("computePayloadHash", () => {
  it("returns sha256:<hex> for a payload", () => {
    const hash = computePayloadHash({ text: "hello" });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic (same input -> same hash)", () => {
    const a = computePayloadHash({ text: "hello" });
    const b = computePayloadHash({ text: "hello" });
    expect(a).toBe(b);
  });

  it("key order does not matter (JCS sorts keys)", () => {
    const a = computePayloadHash({ b: 2, a: 1 });
    const b = computePayloadHash({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("different payloads produce different hashes", () => {
    const a = computePayloadHash({ text: "hello" });
    const b = computePayloadHash({ text: "world" });
    expect(a).not.toBe(b);
  });
});

// ── generateKeypair ──────────────────────────────────────────────

describe("generateKeypair", () => {
  it("returns base64 keys and formatted public key", () => {
    const kp = generateKeypair();
    expect(kp.privateKey).toBeTruthy();
    expect(kp.publicKey).toBeTruthy();
    expect(kp.pubkeyFormatted).toBe(`ed25519:${kp.publicKey}`);

    // Verify base64 decode to 32 bytes
    expect(Buffer.from(kp.privateKey, "base64")).toHaveLength(32);
    expect(Buffer.from(kp.publicKey, "base64")).toHaveLength(32);
  });

  it("generates unique keys each time", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

// ── signChallenge ────────────────────────────────────────────────

describe("signChallenge", () => {
  it("produces a valid Ed25519 signature", () => {
    const kp = generateKeypair();
    const challenge = Buffer.from("test-challenge").toString("base64");
    const sig = signChallenge(kp.privateKey, challenge);

    // Signature should be base64
    expect(Buffer.from(sig, "base64")).toHaveLength(64);

    // Verify signature
    const pubKey = pubKeyFromSeed(kp.privateKey);
    const valid = verify(
      null,
      Buffer.from(challenge, "base64"),
      pubKey,
      Buffer.from(sig, "base64"),
    );
    expect(valid).toBe(true);
  });
});

// ── buildSignedEnvelope ──────────────────────────────────────────

describe("buildSignedEnvelope", () => {
  const kp = generateKeypair();

  it("builds an envelope with all required fields", () => {
    const env = buildSignedEnvelope({
      from: "ag_sender123456",
      to: "ag_receiver1234",
      type: "message",
      payload: { text: "hello" },
      privateKey: kp.privateKey,
      keyId: "k_test",
    });

    expect(env.v).toBe("a2a/0.1");
    expect(env.msg_id).toBeTruthy();
    expect(env.ts).toBeGreaterThan(0);
    expect(env.from).toBe("ag_sender123456");
    expect(env.to).toBe("ag_receiver1234");
    expect(env.type).toBe("message");
    expect(env.reply_to).toBeNull();
    expect(env.ttl_sec).toBe(3600);
    expect(env.payload).toEqual({ text: "hello" });
    expect(env.payload_hash).toMatch(/^sha256:/);
    expect(env.sig.alg).toBe("ed25519");
    expect(env.sig.key_id).toBe("k_test");
    expect(env.sig.value).toBeTruthy();
  });

  it("signature is verifiable", () => {
    const env = buildSignedEnvelope({
      from: "ag_sender123456",
      to: "ag_receiver1234",
      type: "message",
      payload: { text: "verify me" },
      privateKey: kp.privateKey,
      keyId: "k_test",
    });

    // Reconstruct signing input
    const signingInput = [
      "a2a/0.1",
      env.msg_id,
      String(env.ts),
      env.from,
      env.to,
      String(env.type),
      "",
      String(env.ttl_sec),
      env.payload_hash,
    ].join("\n");

    const pubKey = pubKeyFromSeed(kp.privateKey);
    const valid = verify(
      null,
      Buffer.from(signingInput),
      pubKey,
      Buffer.from(env.sig.value, "base64"),
    );
    expect(valid).toBe(true);
  });

  it("uses custom replyTo and ttlSec", () => {
    const env = buildSignedEnvelope({
      from: "ag_a",
      to: "ag_b",
      type: "ack",
      payload: {},
      privateKey: kp.privateKey,
      keyId: "k_test",
      replyTo: "msg-123",
      ttlSec: 600,
    });

    expect(env.reply_to).toBe("msg-123");
    expect(env.ttl_sec).toBe(600);
  });

  it("generates unique msg_id each time", () => {
    const a = buildSignedEnvelope({
      from: "ag_a", to: "ag_b", type: "message",
      payload: { text: "a" }, privateKey: kp.privateKey, keyId: "k_test",
    });
    const b = buildSignedEnvelope({
      from: "ag_a", to: "ag_b", type: "message",
      payload: { text: "a" }, privateKey: kp.privateKey, keyId: "k_test",
    });
    expect(a.msg_id).not.toBe(b.msg_id);
  });
});
