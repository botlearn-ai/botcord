/**
 * Feishu / Lark setup adapter.
 *
 * Owns the PersonalAgent device-flow registration on behalf of the
 * cloud gateway ingress. Login/registration produces an
 * `appId/appSecret/userOpenId` triple which lives ONLY in the setup
 * session's `secretPayload` and is moved into the long-term secret
 * store during `finalize` — at no point is `appSecret` serialized into
 * an HTTP response body or written to logs.
 *
 * See `docs/cloud-gateway-ingress-remediation-plan.md` §5.2.
 *
 * Feishu is event-subscription oriented, so `discover` is not
 * implemented at the MVP stage: the user's own `userOpenId` is captured
 * at registration time and can default into `allowedSenderIds`, and the
 * `allowedChatIds` allowlist is filled in by the user at finalize time.
 */

import type { GatewayConnection } from "../../types.js";
import { maskTokenPreview, mintGatewayId, mintLoginId } from "../sessions.js";
import {
  SetupError,
  type FinalizeRequest,
  type FinalizeResult,
  type LoginStartRequest,
  type LoginStartResult,
  type LoginStatusRequest,
  type LoginStatusResult,
  type ProviderSetupAdapter,
  type SetupContext,
  type TestRequest,
  type TestResult,
} from "../types.js";
import {
  pollFeishuRegistration,
  probeFeishuCredentials,
  startFeishuRegistration,
  type FeishuDomain,
  type FetchLike,
} from "./feishu-registration.js";

export interface FeishuSetupAdapterOptions {
  fetchImpl?: FetchLike;
}

function parseDomain(raw: unknown): FeishuDomain {
  return raw === "lark" ? "lark" : "feishu";
}

/**
 * Map the registration poll result onto the public SetupSessionStatus
 * vocabulary. Mirrors `gateway-control.ts:mapFeishuStatus` in the
 * daemon: denied → failed, expired → expired, failed → failed,
 * pending → pending, confirmed → confirmed.
 */
function mapPollStatus(
  raw: "pending" | "confirmed" | "expired" | "denied" | "failed",
): "pending" | "confirmed" | "expired" | "failed" {
  if (raw === "confirmed") return "confirmed";
  if (raw === "expired") return "expired";
  if (raw === "denied" || raw === "failed") return "failed";
  return "pending";
}

export function createFeishuSetupAdapter(
  opts: FeishuSetupAdapterOptions = {},
): ProviderSetupAdapter {
  const fetchImpl = opts.fetchImpl;

  async function loginStart(
    req: LoginStartRequest,
    ctx: SetupContext,
  ): Promise<LoginStartResult> {
    const domain = parseDomain((req.options as Record<string, unknown> | undefined)?.domain);
    let start;
    try {
      start = await startFeishuRegistration({
        domain,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    } catch (err) {
      ctx.log.warn("feishu login/start registration failed", {
        agentId: req.agentId,
        domain,
        err: redact(String(err)),
      });
      throw new SetupError("provider_unreachable", "feishu registration endpoint unreachable");
    }
    const loginId = mintLoginId("feishu");
    const session = ctx.sessions.create({
      loginId,
      agentId: req.agentId,
      ...(req.userId ? { userId: req.userId } : {}),
      provider: "feishu",
      status: "pending",
      publicPayload: {
        qrcode: start.deviceCode,
        qrcodeUrl: start.verificationUriComplete,
      },
      secretPayload: { domain: start.domain },
    });
    return {
      loginId,
      expiresAt: session.expiresAt,
      publicPayload: {
        qrcode: start.deviceCode,
        qrcodeUrl: start.verificationUriComplete,
        ...(start.verificationUri ? { verificationUrl: start.verificationUri } : {}),
        domain: start.domain,
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
    if (!session || session.provider !== "feishu") {
      throw new SetupError("login_missing", "login id is unknown");
    }

    // Already confirmed: return cached preview, never re-poll, never
    // surface appSecret. The dashboard polls this endpoint on a timer
    // so caching is a correctness requirement, not just an optimization.
    if (session.status === "confirmed" && session.secretPayload.appSecret) {
      return {
        loginId: req.loginId,
        status: "confirmed",
        publicPayload: {
          ...(session.secretPayload.appId ? { appId: session.secretPayload.appId } : {}),
          ...(session.secretPayload.domain ? { domain: session.secretPayload.domain } : {}),
          ...(session.secretPayload.userOpenId
            ? { userOpenId: session.secretPayload.userOpenId }
            : {}),
          ...(session.publicPayload.tokenPreview
            ? { tokenPreview: session.publicPayload.tokenPreview }
            : {}),
        },
        expiresAt: session.expiresAt,
      };
    }

    const deviceCode = session.publicPayload.qrcode;
    if (!deviceCode) {
      throw new SetupError("internal", "setup session missing device code");
    }
    const domain: FeishuDomain = session.secretPayload.domain ?? "feishu";
    let probe;
    try {
      probe = await pollFeishuRegistration(deviceCode, {
        domain,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    } catch (err) {
      ctx.log.warn("feishu login/status poll failed", {
        agentId: req.agentId,
        loginId: req.loginId,
        domain,
        err: redact(String(err)),
      });
      throw new SetupError("provider_unreachable", "feishu poll endpoint unreachable");
    }

    const status = mapPollStatus(probe.status);
    const patch: Parameters<typeof ctx.sessions.update>[1] = { status };
    let tokenPreview: string | undefined;
    if (status === "confirmed" && probe.appId && probe.appSecret) {
      tokenPreview = maskTokenPreview(probe.appSecret);
      patch.secretPayload = {
        appId: probe.appId,
        appSecret: probe.appSecret,
        domain: probe.domain,
        ...(probe.userOpenId ? { userOpenId: probe.userOpenId } : {}),
      };
      patch.publicPayload = { tokenPreview };
    } else if (probe.domain && probe.domain !== domain) {
      patch.secretPayload = { domain: probe.domain };
    }

    const updated = ctx.sessions.update(req.loginId, patch);
    if (!updated) {
      throw new SetupError("login_expired", "login session expired");
    }

    if (updated.status === "confirmed" && updated.secretPayload.appSecret) {
      return {
        loginId: req.loginId,
        status: "confirmed",
        publicPayload: {
          ...(updated.secretPayload.appId ? { appId: updated.secretPayload.appId } : {}),
          ...(updated.secretPayload.domain ? { domain: updated.secretPayload.domain } : {}),
          ...(updated.secretPayload.userOpenId
            ? { userOpenId: updated.secretPayload.userOpenId }
            : {}),
          ...(tokenPreview ?? updated.publicPayload.tokenPreview
            ? { tokenPreview: tokenPreview ?? updated.publicPayload.tokenPreview }
            : {}),
        },
        expiresAt: updated.expiresAt,
      };
    }
    return {
      loginId: req.loginId,
      status: updated.status,
      publicPayload: {
        domain: updated.secretPayload.domain ?? domain,
      },
      expiresAt: updated.expiresAt,
    };
  }

  async function finalize(
    req: FinalizeRequest,
    ctx: SetupContext,
  ): Promise<FinalizeResult> {
    const { state, session } = ctx.sessions.resolve(req.loginId);
    if (state === "missing") throw new SetupError("login_missing", "login id is unknown");
    if (state === "expired") throw new SetupError("login_expired", "login session expired");
    if (!session || session.provider !== "feishu") {
      throw new SetupError("login_missing", "login id is unknown");
    }
    const { appId, appSecret, domain, userOpenId } = session.secretPayload;
    if (
      session.status !== "confirmed" ||
      !appId ||
      !appSecret ||
      !domain
    ) {
      throw new SetupError("login_unconfirmed", "feishu login is not confirmed yet");
    }

    // §8 gateway_conflict: same appId already owned by an active
    // connection (regardless of agent) — the open-platform tenant_access
    // _token has one owner, so refuse a duplicate.
    for (const existing of ctx.store.listConnections()) {
      if (
        existing.provider === "feishu" &&
        existing.enabled &&
        existing.status !== "disabled"
      ) {
        const ref = existing.secretRef;
        if (!ref) continue;
        const stored = ctx.secrets.load<{ appId?: string }>(ref);
        if (stored?.appId && stored.appId === appId) {
          throw new SetupError(
            "gateway_conflict",
            "feishu app id is already owned by another active gateway",
          );
        }
      }
    }

    const gatewayId = mintGatewayId("feishu");
    // §6.1 contract: secretRef === connection.id.
    ctx.secrets.write(gatewayId, {
      appId,
      appSecret,
      domain,
      ...(userOpenId ? { userOpenId } : {}),
    });

    const cfg = (req.config ?? {}) as Record<string, unknown>;
    const allowedSenderIds = Array.isArray(cfg.allowedSenderIds)
      ? (cfg.allowedSenderIds as unknown[]).filter((x): x is string => typeof x === "string")
      : userOpenId
        ? [userOpenId]
        : [];
    const allowedChatIds = Array.isArray(cfg.allowedChatIds)
      ? (cfg.allowedChatIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const safeConfig: Record<string, unknown> = {
      domain,
      ...(userOpenId ? { userOpenId } : {}),
      ...(allowedSenderIds.length > 0 ? { allowedSenderIds } : {}),
      ...(allowedChatIds.length > 0 ? { allowedChatIds } : {}),
      ...(typeof cfg.splitAt === "number" ? { splitAt: cfg.splitAt } : {}),
    };

    const now = ctx.now();
    const enabled = req.enabled !== false;
    const connection: GatewayConnection = {
      id: gatewayId,
      agentId: req.agentId,
      ...(req.userId ? { userId: req.userId } : {}),
      provider: "feishu",
      ...(req.label ? { label: req.label } : {}),
      status: enabled ? "pending" : "disabled",
      enabled,
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
    if (!conn || conn.provider !== "feishu") {
      throw new SetupError("not_found", "gateway not found");
    }
    if (!conn.secretRef) {
      throw new SetupError("provider_auth_failed", "gateway missing secret reference");
    }
    const secret = ctx.secrets.load<{
      appId?: string;
      appSecret?: string;
      domain?: FeishuDomain;
    }>(conn.secretRef);
    if (!secret?.appId || !secret.appSecret) {
      throw new SetupError("provider_auth_failed", "gateway missing app credentials");
    }
    const domain: FeishuDomain = secret.domain ?? "feishu";
    try {
      const probe = await probeFeishuCredentials(secret.appId, secret.appSecret, {
        domain,
        ...(fetchImpl ? { fetchImpl } : {}),
        timeoutMs: 3000,
      });
      if (!probe.ok) {
        return {
          ok: false,
          details: {
            ...(probe.code !== undefined ? { code: probe.code } : {}),
          },
        };
      }
      return { ok: true, details: { domain } };
    } catch (err) {
      ctx.log.warn("feishu test failed", {
        gatewayId: req.gatewayId,
        err: redact(String(err), secret.appSecret),
      });
      return { ok: false };
    }
  }

  return {
    provider: "feishu",
    loginStart,
    loginStatus,
    finalize,
    test,
  };
}

function redact(input: string, token?: string): string {
  if (!token) return input;
  return input.split(token).join("[REDACTED]");
}
