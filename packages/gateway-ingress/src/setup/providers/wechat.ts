/**
 * WeChat (iLink) setup adapter.
 *
 * Implements the loginStart / loginStatus / discover / finalize / test
 * shape declared in `../types.ts`. The temporary botToken lives in the
 * setup session's `secretPayload` and is moved into the long-term
 * secret store during `finalize` — at no point is it serialized into
 * any HTTP response body.
 */

import type { GatewayConnection } from "../../types.js";
import { maskTokenPreview, mintGatewayId } from "../sessions.js";
import {
  SetupError,
  type LoginStartRequest,
  type LoginStartResult,
  type LoginStatusRequest,
  type LoginStatusResult,
  type DiscoverRequest,
  type DiscoverResult,
  type FinalizeRequest,
  type FinalizeResult,
  type ProviderSetupAdapter,
  type SetupContext,
  type TestRequest,
  type TestResult,
} from "../types.js";
import {
  DEFAULT_WECHAT_BASE_URL,
  getBotQrcode,
  getBotUpdates,
  getQrcodeStatus,
  type FetchLike,
} from "./wechat-login.js";

import { mintLoginId } from "../sessions.js";

export interface WechatSetupAdapterOptions {
  fetchImpl?: FetchLike;
  /** Override the default iLink base url (e.g. for E2E against a stub). */
  baseUrl?: string;
}

export function createWechatSetupAdapter(
  opts: WechatSetupAdapterOptions = {},
): ProviderSetupAdapter {
  const fetchImpl = opts.fetchImpl;
  const baseUrl = opts.baseUrl ?? DEFAULT_WECHAT_BASE_URL;

  async function loginStart(
    req: LoginStartRequest,
    ctx: SetupContext,
  ): Promise<LoginStartResult> {
    let qr;
    try {
      qr = await getBotQrcode({ ...(fetchImpl ? { fetchImpl } : {}), baseUrl });
    } catch (err) {
      ctx.log.warn("wechat login/start get_bot_qrcode failed", {
        agentId: req.agentId,
        err: redact(String(err)),
      });
      throw new SetupError("provider_unreachable", "wechat qrcode endpoint unreachable");
    }
    const loginId = mintLoginId("wechat");
    const session = ctx.sessions.create({
      loginId,
      agentId: req.agentId,
      ...(req.userId ? { userId: req.userId } : {}),
      provider: "wechat",
      status: "pending",
      publicPayload: {
        qrcode: qr.qrcode,
        ...(qr.qrcodeUrl ? { qrcodeUrl: qr.qrcodeUrl } : {}),
      },
      secretPayload: { baseUrl },
    });
    return {
      loginId,
      expiresAt: session.expiresAt,
      publicPayload: {
        qrcode: qr.qrcode,
        ...(qr.qrcodeUrl ? { qrcodeUrl: qr.qrcodeUrl } : {}),
      },
    };
  }

  async function loginStatus(
    req: LoginStatusRequest,
    ctx: SetupContext,
  ): Promise<LoginStatusResult> {
    const { state, session } = ctx.sessions.resolve(req.loginId);
    if (state === "missing") throw new SetupError("login_missing", "login id is unknown");
    if (state === "expired") throw new SetupError("login_expired", "login session expired");
    if (!session || session.provider !== "wechat") {
      throw new SetupError("login_missing", "login id is unknown");
    }
    const qrcode = session.publicPayload.qrcode;
    if (!qrcode) {
      throw new SetupError("internal", "setup session missing qrcode");
    }
    let resp;
    try {
      resp = await getQrcodeStatus(qrcode, {
        ...(fetchImpl ? { fetchImpl } : {}),
        baseUrl: session.secretPayload.baseUrl ?? baseUrl,
      });
    } catch (err) {
      ctx.log.warn("wechat login/status get_qrcode_status failed", {
        agentId: req.agentId,
        loginId: req.loginId,
        err: redact(String(err)),
      });
      throw new SetupError("provider_unreachable", "wechat qrcode status endpoint unreachable");
    }
    const status = mapQrcodeStatus(resp.status);
    const patch: Parameters<typeof ctx.sessions.update>[1] = { status };
    let tokenPreview: string | undefined;
    if (status === "confirmed" && resp.botToken) {
      patch.secretPayload = {
        botToken: resp.botToken,
        ...(resp.baseUrl ? { baseUrl: resp.baseUrl } : {}),
      };
      tokenPreview = maskTokenPreview(resp.botToken);
      patch.publicPayload = { tokenPreview };
    }
    const updated = ctx.sessions.update(req.loginId, patch);
    if (!updated) {
      throw new SetupError("login_expired", "login session expired");
    }
    return {
      loginId: req.loginId,
      status: updated.status,
      publicPayload: {
        ...(updated.publicPayload.qrcode ? { qrcode: updated.publicPayload.qrcode } : {}),
        ...(updated.publicPayload.qrcodeUrl ? { qrcodeUrl: updated.publicPayload.qrcodeUrl } : {}),
        ...(updated.publicPayload.tokenPreview ? { tokenPreview: updated.publicPayload.tokenPreview } : {}),
      },
      expiresAt: updated.expiresAt,
    };
  }

  async function discover(
    req: DiscoverRequest,
    ctx: SetupContext,
  ): Promise<DiscoverResult> {
    const { state, session } = ctx.sessions.resolve(req.loginId);
    if (state === "missing") throw new SetupError("login_missing", "login id is unknown");
    if (state === "expired") throw new SetupError("login_expired", "login session expired");
    if (!session || session.provider !== "wechat") {
      throw new SetupError("login_missing", "login id is unknown");
    }
    if (session.status !== "confirmed" || !session.secretPayload.botToken) {
      throw new SetupError("login_unconfirmed", "login is not confirmed yet");
    }
    let resp;
    try {
      resp = await getBotUpdates(session.secretPayload.botToken, {
        ...(fetchImpl ? { fetchImpl } : {}),
        baseUrl: session.secretPayload.baseUrl ?? baseUrl,
        timeoutMs: 3000,
      });
    } catch (err) {
      ctx.log.warn("wechat discover getupdates failed", {
        agentId: req.agentId,
        loginId: req.loginId,
        err: redact(String(err), session.secretPayload.botToken),
      });
      throw new SetupError("provider_unreachable", "wechat updates endpoint unreachable");
    }
    const seen = new Map<string, { senderId: string; preview?: string }>();
    for (const msg of resp.msgs ?? []) {
      if (msg.message_type !== 1) continue;
      const uid = typeof msg.from_user_id === "string" ? msg.from_user_id : "";
      if (!uid) continue;
      if (seen.has(uid)) continue;
      let preview: string | undefined;
      for (const item of msg.item_list ?? []) {
        if (item?.type === 1 && typeof item.text_item?.text === "string") {
          preview = item.text_item.text.slice(0, 80);
          break;
        }
      }
      seen.set(uid, { senderId: uid, ...(preview ? { preview } : {}) });
    }
    return { candidates: [...seen.values()] };
  }

  async function finalize(
    req: FinalizeRequest,
    ctx: SetupContext,
  ): Promise<FinalizeResult> {
    const { state, session } = ctx.sessions.resolve(req.loginId);
    if (state === "missing") throw new SetupError("login_missing", "login id is unknown");
    if (state === "expired") throw new SetupError("login_expired", "login session expired");
    if (!session || session.provider !== "wechat") {
      throw new SetupError("login_missing", "login id is unknown");
    }
    if (session.status !== "confirmed" || !session.secretPayload.botToken) {
      throw new SetupError("login_unconfirmed", "login is not confirmed yet");
    }
    const gatewayId = mintGatewayId("wechat");
    // §6.1: secretRef equals connection.id.
    ctx.secrets.write(gatewayId, {
      botToken: session.secretPayload.botToken,
      baseUrl: session.secretPayload.baseUrl ?? baseUrl,
    });
    const cfg = (req.config ?? {}) as Record<string, unknown>;
    const safeConfig: Record<string, unknown> = {
      baseUrl: session.secretPayload.baseUrl ?? baseUrl,
      ...(Array.isArray(cfg.allowedSenderIds) ? { allowedSenderIds: cfg.allowedSenderIds } : {}),
      ...(typeof cfg.splitAt === "number" ? { splitAt: cfg.splitAt } : {}),
    };
    const now = ctx.now();
    const connection: GatewayConnection = {
      id: gatewayId,
      agentId: req.agentId,
      ...(req.userId ? { userId: req.userId } : {}),
      provider: "wechat",
      ...(req.label ? { label: req.label } : {}),
      status: "active",
      enabled: true,
      config: safeConfig,
      secretRef: gatewayId,
      createdAt: now,
      updatedAt: now,
    };
    ctx.store.upsertConnection(connection);
    ctx.sessions.delete(req.loginId);
    return { connection };
  }

  async function test(
    req: TestRequest,
    ctx: SetupContext,
  ): Promise<TestResult> {
    const conn = ctx.store.getConnection(req.gatewayId);
    if (!conn || conn.provider !== "wechat") {
      throw new SetupError("not_found", "gateway not found");
    }
    if (!conn.secretRef) {
      throw new SetupError("provider_auth_failed", "gateway missing secret reference");
    }
    const secret = ctx.secrets.load<{ botToken?: string; baseUrl?: string }>(conn.secretRef);
    if (!secret?.botToken) {
      throw new SetupError("provider_auth_failed", "gateway missing bot token");
    }
    try {
      const resp = await getBotUpdates(secret.botToken, {
        ...(fetchImpl ? { fetchImpl } : {}),
        baseUrl: secret.baseUrl ?? baseUrl,
        timeoutMs: 3000,
      });
      if (resp.ret !== undefined && resp.ret !== 0) {
        return { ok: false, details: { ret: resp.ret } };
      }
      return { ok: true };
    } catch (err) {
      ctx.log.warn("wechat test failed", {
        gatewayId: req.gatewayId,
        err: redact(String(err), secret.botToken),
      });
      return { ok: false };
    }
  }

  return {
    provider: "wechat",
    loginStart,
    loginStatus,
    discover,
    finalize,
    test,
  };
}

function mapQrcodeStatus(raw: string): "pending" | "scanned" | "confirmed" | "failed" {
  // iLink uses strings like "0"/"1"/"2"/"3" or "wait"/"scanned"/"confirmed"
  // depending on version. Normalize defensively.
  const norm = raw.toLowerCase();
  if (norm === "confirmed" || norm === "3" || norm === "ok" || norm === "success") return "confirmed";
  if (norm === "scanned" || norm === "2") return "scanned";
  if (norm === "expired" || norm === "failed" || norm === "4" || norm === "5") return "failed";
  return "pending";
}

function redact(input: string, token?: string): string {
  if (!token) return input;
  return input.split(token).join("[REDACTED]");
}
