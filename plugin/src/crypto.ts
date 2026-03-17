/**
 * Ed25519 signing for BotCord protocol.
 * Zero npm dependencies — uses Node.js built-in crypto module.
 * Ported from botcord-skill/skill/botcord-crypto.mjs.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  randomUUID,
} from "node:crypto";
import type { BotCordMessageEnvelope, BotCordSignature, MessageType } from "./types.js";

// ── JCS (RFC 8785) canonicalization ─────────────────────────────
export function jcsCanonicalize(value: unknown): string | undefined {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "0";
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map((v) => jcsCanonicalize(v)).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ":" + jcsCanonicalize(v));
    }
    return "{" + parts.join(",") + "}";
  }
  return undefined;
}

// ── Build Node.js KeyObject from raw 32-byte seed ───────────────
function privateKeyFromSeed(seed: Buffer): ReturnType<typeof createPrivateKey> {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
}

// ── Payload hash ────────────────────────────────────────────────
export function computePayloadHash(payload: Record<string, unknown>): string {
  const canonical = jcsCanonicalize(payload)!;
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${digest}`;
}

// ── Sign challenge ──────────────────────────────────────────────
export function signChallenge(privateKeyB64: string, challengeB64: string): string {
  const pk = privateKeyFromSeed(Buffer.from(privateKeyB64, "base64"));
  const sig = sign(null, Buffer.from(challengeB64, "base64"), pk);
  return sig.toString("base64");
}

// ── Build and sign a full message envelope ──────────────────────
export function buildSignedEnvelope(params: {
  from: string;
  to: string;
  type: MessageType;
  payload: Record<string, unknown>;
  privateKey: string; // base64 Ed25519 seed
  keyId: string;
  replyTo?: string | null;
  ttlSec?: number;
  topic?: string | null;
  goal?: string | null;
}): BotCordMessageEnvelope {
  const {
    from,
    to,
    type,
    payload,
    privateKey,
    keyId,
    replyTo = null,
    ttlSec = 3600,
    topic = null,
    goal = null,
  } = params;

  const msgId = randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  const payloadHash = computePayloadHash(payload);

  // Build signing input (newline-joined fields)
  const parts = [
    "a2a/0.1",
    msgId,
    String(ts),
    from,
    to,
    String(type),
    replyTo || "",
    String(ttlSec),
    payloadHash,
  ];

  const pk = privateKeyFromSeed(Buffer.from(privateKey, "base64"));
  const sigValue = sign(null, Buffer.from(parts.join("\n")), pk);

  const sig: BotCordSignature = {
    alg: "ed25519",
    key_id: keyId,
    value: sigValue.toString("base64"),
  };

  return {
    v: "a2a/0.1",
    msg_id: msgId,
    ts,
    from,
    to,
    type,
    reply_to: replyTo,
    ttl_sec: ttlSec,
    topic,
    goal,
    payload,
    payload_hash: payloadHash,
    sig,
  };
}

// ── Keygen ──────────────────────────────────────────────────────
export function generateKeypair(): {
  privateKey: string;
  publicKey: string;
  pubkeyFormatted: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const privB64 = Buffer.from(privDer.subarray(-32)).toString("base64");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const pubB64 = Buffer.from(pubDer.subarray(-32)).toString("base64");
  return {
    privateKey: privB64,
    publicKey: pubB64,
    pubkeyFormatted: `ed25519:${pubB64}`,
  };
}
