/**
 * Shared HTTP plumbing for the iLink WeChat adapter and its login helper.
 *
 * Centralises the four mandatory headers (`AuthorizationType`,
 * `Authorization`, `X-WECHAT-UIN`, `Content-Type`) so the adapter and the
 * login flow can't drift on header shape — the iLink server rejects requests
 * that omit any of them.
 */

import { randomBytes } from "node:crypto";

// W7: canonical FetchLike now lives in http-types.ts; re-export for callers
// that historically imported it from this module.
export type { FetchLike } from "./http-types.js";

/** `X-WECHAT-UIN: base64(str(random uint32))` — fresh per request, anti-replay. */
export function wechatUinHeader(): string {
  const n = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), "utf8").toString("base64");
}

/** Build the canonical iLink request headers. Token is optional for login calls. */
export function wechatHeaders(botToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": wechatUinHeader(),
  };
  if (botToken) h["Authorization"] = `Bearer ${botToken}`;
  return h;
}

/** iLink `base_info` block required on every authenticated POST body. */
export const WECHAT_CHANNEL_VERSION = "1.0.2";
export const WECHAT_BASE_INFO = { channel_version: WECHAT_CHANNEL_VERSION } as const;
