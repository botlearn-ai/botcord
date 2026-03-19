/**
 * [INPUT]: 依赖 node:crypto 生成随机 nonce 与 HMAC 签名，依赖环境变量 BIND_PROOF_SECRET
 * [OUTPUT]: 对外提供 bind_ticket 的签发与校验能力（issueBindTicket/verifyBindTicket）
 * [POS]: Next.js BFF 的一次性绑定凭证模块，约束 bind_proof 的时效与归属
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

interface BindTicketPayload {
  uid: string;
  nonce: string;
  exp: number;
  iat: number;
  jti: string;
}

function getSecret(): string {
  const secret = process.env.BIND_PROOF_SECRET || process.env.JWT_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error("BIND_PROOF_SECRET is not configured");
  }
  return secret;
}

function signPart(payloadPart: string): string {
  const mac = createHmac("sha256", getSecret()).update(payloadPart).digest("base64url");
  return mac;
}

function safeEqualText(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function issueBindTicket(
  userId: string,
  ttlSeconds = 300,
): { bindTicket: string; nonce: string; expiresAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(32).toString("base64");
  const payload: BindTicketPayload = {
    uid: userId,
    nonce,
    iat: now,
    exp: now + ttlSeconds,
    jti: randomBytes(12).toString("hex"),
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sigPart = signPart(payloadPart);
  return {
    bindTicket: `${payloadPart}.${sigPart}`,
    nonce,
    expiresAt: payload.exp,
  };
}

export function verifyBindTicket(
  bindTicket: string,
  userId: string,
  nonce: string,
): { ok: true } | { ok: false; reason: string } {
  const parts = bindTicket.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "invalid_ticket_format" };
  }
  const [payloadPart, sigPart] = parts;
  const expectedSig = signPart(payloadPart);
  if (!safeEqualText(sigPart, expectedSig)) {
    return { ok: false, reason: "invalid_ticket_signature" };
  }

  let payload: BindTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as BindTicketPayload;
  } catch {
    return { ok: false, reason: "invalid_ticket_payload" };
  }

  if (payload.uid !== userId) {
    return { ok: false, reason: "ticket_user_mismatch" };
  }
  if (payload.nonce !== nonce) {
    return { ok: false, reason: "ticket_nonce_mismatch" };
  }
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, reason: "ticket_expired" };
  }

  return { ok: true };
}
