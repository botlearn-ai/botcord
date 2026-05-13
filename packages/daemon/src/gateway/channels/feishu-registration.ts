/**
 * Feishu/Lark PersonalAgent app registration helpers.
 *
 * Mirrors the flow used by `@larksuite/openclaw-lark-tools`:
 *   POST /oauth/v1/app/registration action=init
 *   POST /oauth/v1/app/registration action=begin
 *   POST /oauth/v1/app/registration action=poll
 */

import type { FetchLike } from "./http-types.js";

export type FeishuDomain = "feishu" | "lark";

const FEISHU_ACCOUNTS_BASE = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_BASE = "https://accounts.larksuite.com";

export interface FeishuRegistrationOptions {
  domain?: FeishuDomain;
  fetchImpl?: FetchLike;
}

export interface FeishuRegistrationStart {
  deviceCode: string;
  verificationUriComplete: string;
  verificationUri?: string;
  expiresIn: number;
  interval: number;
  domain: FeishuDomain;
  raw: Record<string, unknown>;
}

export interface FeishuRegistrationPoll {
  status: "pending" | "confirmed" | "expired" | "denied" | "failed";
  appId?: string;
  appSecret?: string;
  userOpenId?: string;
  domain: FeishuDomain;
  interval?: number;
  error?: string;
  raw: Record<string, unknown>;
}

function baseForDomain(domain: FeishuDomain): string {
  return domain === "lark" ? LARK_ACCOUNTS_BASE : FEISHU_ACCOUNTS_BASE;
}

function fetcher(opts: FeishuRegistrationOptions): FetchLike {
  return opts.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
}

async function postRegistration(
  action: string,
  params: Record<string, string>,
  opts: FeishuRegistrationOptions,
): Promise<Record<string, unknown>> {
  const domain = opts.domain ?? "feishu";
  const res = await fetcher(opts)(`${baseForDomain(domain)}/oauth/v1/app/registration`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action, ...params }).toString(),
  });
  const raw = await res.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`feishu registration ${action}: non-json response`);
  }
}

export async function startFeishuRegistration(
  opts: FeishuRegistrationOptions = {},
): Promise<FeishuRegistrationStart> {
  const domain = opts.domain ?? "feishu";
  const init = await postRegistration("init", {}, { ...opts, domain });
  const methods = Array.isArray(init.supported_auth_methods)
    ? init.supported_auth_methods.map(String)
    : [];
  if (methods.length > 0 && !methods.includes("client_secret")) {
    throw new Error("feishu registration: client_secret auth is not supported");
  }
  const begin = await postRegistration(
    "begin",
    {
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    },
    { ...opts, domain },
  );
  const deviceCode = typeof begin.device_code === "string" ? begin.device_code : "";
  const verificationUriComplete =
    typeof begin.verification_uri_complete === "string"
      ? begin.verification_uri_complete
      : "";
  if (!deviceCode || !verificationUriComplete) {
    throw new Error("feishu registration: missing device_code or verification_uri_complete");
  }
  return {
    deviceCode,
    verificationUriComplete,
    ...(typeof begin.verification_uri === "string"
      ? { verificationUri: begin.verification_uri }
      : {}),
    expiresIn: typeof begin.expire_in === "number" ? begin.expire_in : 600,
    interval: typeof begin.interval === "number" ? begin.interval : 5,
    domain,
    raw: begin,
  };
}

export async function pollFeishuRegistration(
  deviceCode: string,
  opts: FeishuRegistrationOptions = {},
): Promise<FeishuRegistrationPoll> {
  const domain = opts.domain ?? "feishu";
  const data = await postRegistration(
    "poll",
    { device_code: deviceCode },
    { ...opts, domain },
  );
  const tenantBrand =
    typeof (data.user_info as Record<string, unknown> | undefined)?.tenant_brand === "string"
      ? String((data.user_info as Record<string, unknown>).tenant_brand)
      : "";
  const resolvedDomain: FeishuDomain = tenantBrand === "lark" ? "lark" : domain;
  const appId = typeof data.client_id === "string" ? data.client_id : undefined;
  const appSecret =
    typeof data.client_secret === "string" ? data.client_secret : undefined;
  if (appId && appSecret) {
    const userInfo = data.user_info as Record<string, unknown> | undefined;
    return {
      status: "confirmed",
      appId,
      appSecret,
      userOpenId: typeof userInfo?.open_id === "string" ? userInfo.open_id : undefined,
      domain: resolvedDomain,
      raw: data,
    };
  }
  const error = typeof data.error === "string" ? data.error : "";
  if (!error || error === "authorization_pending") {
    return { status: "pending", domain: resolvedDomain, raw: data };
  }
  if (error === "slow_down") {
    return { status: "pending", domain: resolvedDomain, interval: 10, raw: data };
  }
  if (error === "access_denied") {
    return { status: "denied", domain: resolvedDomain, error, raw: data };
  }
  if (error === "expired_token" || error === "invalid_grant") {
    return { status: "expired", domain: resolvedDomain, error, raw: data };
  }
  return { status: "failed", domain: resolvedDomain, error: error || "unknown", raw: data };
}
