/**
 * iLink WeChat QR-code login helpers.
 *
 * Co-located with the channel adapter so the small set of unauthenticated
 * iLink endpoints (`get_bot_qrcode`, `get_qrcode_status`) used during the
 * scan-confirm flow stay alongside the authenticated calls in `wechat.ts`.
 *
 * This module deliberately exports ONLY the two HTTP calls. Login session
 * persistence (mapping `loginId` → `{accountId, gatewayId, botToken, ...}`)
 * is owned by the control-plane layer and is out of scope here.
 */

import { wechatHeaders, type FetchLike } from "./wechat-http.js";

export const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";

export interface WechatQrcode {
  qrcode: string;
  qrcodeUrl?: string;
  raw: Record<string, unknown>;
}

export interface WechatQrcodeStatus {
  status: string;
  botToken?: string;
  baseUrl?: string;
  raw: Record<string, unknown>;
}

export interface WechatLoginOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** `GET /ilink/bot/get_bot_qrcode?bot_type=3` — fetch a fresh login QR. */
export async function getBotQrcode(opts: WechatLoginOptions = {}): Promise<WechatQrcode> {
  const base = (opts.baseUrl ?? DEFAULT_WECHAT_BASE_URL).replace(/\/+$/, "");
  const fetcher = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const res = await fetcher(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    method: "GET",
    headers: wechatHeaders(),
  });
  const data = (await safeJson(res)) ?? {};
  const qrcode = typeof data.qrcode === "string" ? data.qrcode : "";
  if (!qrcode) {
    throw new Error(`wechat get_bot_qrcode: missing qrcode in response`);
  }
  const qrcodeUrl =
    (typeof data.qrcode_url === "string" && data.qrcode_url) ||
    (typeof data.qrcode_img_content === "string" && data.qrcode_img_content) ||
    undefined;
  return { qrcode, qrcodeUrl, raw: data };
}

/**
 * `GET /ilink/bot/get_qrcode_status?qrcode=...` — poll for scan/confirm.
 * Caller is responsible for backoff and TTL; this just returns the parsed
 * server response.
 */
export async function getQrcodeStatus(
  qrcode: string,
  opts: WechatLoginOptions = {},
): Promise<WechatQrcodeStatus> {
  const base = (opts.baseUrl ?? DEFAULT_WECHAT_BASE_URL).replace(/\/+$/, "");
  const fetcher = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const res = await fetcher(
    `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { method: "GET", headers: wechatHeaders() },
  );
  const data = (await safeJson(res)) ?? {};
  const status = typeof data.status === "string" ? data.status : "unknown";
  const botToken = typeof data.bot_token === "string" ? data.bot_token : undefined;
  const baseUrl = typeof data.baseurl === "string" ? data.baseurl : undefined;
  return { status, botToken, baseUrl, raw: data };
}

async function safeJson(res: { text(): Promise<string> }): Promise<Record<string, unknown> | null> {
  try {
    const raw = await res.text();
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
