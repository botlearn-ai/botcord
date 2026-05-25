/**
 * iLink WeChat QR-code login helpers, copied into the ingress namespace.
 *
 * Mirror of `packages/daemon/src/gateway/channels/wechat-login.ts`.
 * Duplicated intentionally — ingress must not depend on the daemon
 * package (per remediation plan §1.2: daemon is the runtime executor,
 * ingress owns setup). The wire shapes here track the iLink server, not
 * the daemon's internal types.
 *
 * This module exposes ONLY the three unauthenticated iLink endpoints
 * used during the scan-confirm-discover flow. Long-term polling lives
 * in `../providers/wechat.ts`.
 */

import { randomBytes } from "node:crypto";

import { assertSafeBaseUrl } from "../url-guard.js";

export const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WechatLoginOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

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

export interface WechatUpdatesResp {
  ret?: number;
  get_updates_buf?: string;
  msgs?: Array<{
    message_type?: number;
    from_user_id?: string;
    item_list?: Array<{ type?: number; text_item?: { text?: string } }>;
    [k: string]: unknown;
  }>;
}

function wechatUinHeader(): string {
  const n = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), "utf8").toString("base64");
}

function wechatHeaders(botToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": wechatUinHeader(),
  };
  if (botToken) h["Authorization"] = `Bearer ${botToken}`;
  return h;
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

/** `GET /ilink/bot/get_bot_qrcode?bot_type=3` — fetch a fresh login QR. */
export async function getBotQrcode(opts: WechatLoginOptions = {}): Promise<WechatQrcode> {
  assertSafeBaseUrl(opts.baseUrl);
  const base = (opts.baseUrl ?? DEFAULT_WECHAT_BASE_URL).replace(/\/+$/, "");
  const fetcher = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const res = await fetcher(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    method: "GET",
    headers: wechatHeaders(),
  });
  const data = (await safeJson(res)) ?? {};
  const qrcode = typeof data.qrcode === "string" ? data.qrcode : "";
  if (!qrcode) {
    throw new Error("wechat get_bot_qrcode: missing qrcode in response");
  }
  const qrcodeUrl =
    (typeof data.qrcode_url === "string" && data.qrcode_url) ||
    (typeof data.qrcode_img_content === "string" && data.qrcode_img_content) ||
    undefined;
  return { qrcode, qrcodeUrl, raw: data };
}

/** `GET /ilink/bot/get_qrcode_status?qrcode=...` — poll for scan/confirm. */
export async function getQrcodeStatus(
  qrcode: string,
  opts: WechatLoginOptions = {},
): Promise<WechatQrcodeStatus> {
  assertSafeBaseUrl(opts.baseUrl);
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

/**
 * `POST /ilink/bot/getupdates` for the recent-senders discovery step.
 * Uses a very short timeout — discovery is best-effort, not the long
 * poll path used by the live adapter. The bot token here is the
 * temporary one stored in the setup session.
 */
export async function getBotUpdates(
  botToken: string,
  opts: WechatLoginOptions & { timeoutMs?: number; updatesBuf?: string } = {},
): Promise<WechatUpdatesResp> {
  assertSafeBaseUrl(opts.baseUrl);
  const base = (opts.baseUrl ?? DEFAULT_WECHAT_BASE_URL).replace(/\/+$/, "");
  const fetcher = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5_000);
  try {
    const res = await fetcher(`${base}/ilink/bot/getupdates`, {
      method: "POST",
      headers: wechatHeaders(botToken),
      body: JSON.stringify({
        get_updates_buf: opts.updatesBuf ?? "",
        base_info: { channel_version: "1.0.2" },
      }),
      signal: ac.signal,
    });
    const data = (await safeJson(res)) ?? {};
    return data as WechatUpdatesResp;
  } finally {
    clearTimeout(timer);
  }
}
