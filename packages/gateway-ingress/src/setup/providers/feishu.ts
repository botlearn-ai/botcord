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
 * After registration confirms, `discover` temporarily opens the Feishu
 * event websocket with the setup-session app credentials and captures
 * chat_id values only from the registered userOpenId.
 */

import * as Lark from "@larksuiteoapi/node-sdk";

import type { GatewayConnection } from "../../types.js";
import { maskTokenPreview, mintGatewayId, mintLoginId } from "../sessions.js";
import {
  SetupError,
  type DiscoverRequest,
  type DiscoverResult,
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
  /** Test hook: bypass the lark SDK for temporary discovery sockets. */
  sdkOverride?: FeishuDiscoverySdkOverride;
}

function parseDomain(raw: unknown): FeishuDomain {
  return raw === "lark" ? "lark" : "feishu";
}

interface FeishuEventSender {
  sender_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  sender_type?: string;
  tenant_key?: string;
}

interface FeishuEventMessage {
  message_id?: string;
  create_time?: string;
  chat_id?: string;
  chat_type?: string;
  mentions?: Array<{ id?: { open_id?: string; user_id?: string }; name?: string }>;
}

interface FeishuMessageEvent {
  sender?: FeishuEventSender;
  message?: FeishuEventMessage;
}

interface FeishuDiscoveredChat {
  chatId: string;
  senderOpenId: string;
  kind: "direct" | "group";
  label?: string | null;
  lastSeenAt: number;
}

export interface FeishuDiscoverySdkOverride {
  createWsClient(args: Record<string, unknown>): {
    start(opts: unknown): unknown;
    close(opts?: unknown): unknown;
  };
  createDispatcher(): {
    register(handlers: Record<string, (data: unknown) => unknown>): void;
  };
}

function sdkDomain(domain: FeishuDomain | undefined): unknown {
  const sdk = Lark as unknown as { Domain?: { Feishu?: unknown; Lark?: unknown } };
  return domain === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu;
}

function senderLabel(event: FeishuMessageEvent): string | undefined {
  const mentions = event.message?.mentions ?? [];
  const senderOpenId = event.sender?.sender_id?.open_id;
  const hit = mentions.find((m) => m.id?.open_id && m.id.open_id === senderOpenId);
  return typeof hit?.name === "string" && hit.name ? hit.name : undefined;
}

function discoveryChatFromEvent(
  event: FeishuMessageEvent,
  allowedSenderOpenId: string,
  now: () => number,
): FeishuDiscoveredChat | null {
  const message = event.message;
  const senderOpenId = event.sender?.sender_id?.open_id;
  const chatId = message?.chat_id;
  if (!message || !senderOpenId || !chatId) return null;
  if (senderOpenId !== allowedSenderOpenId) return null;
  return {
    chatId,
    senderOpenId,
    kind: message.chat_type === "p2p" ? "direct" : "group",
    label: senderLabel(event) ?? null,
    lastSeenAt: Number(message.create_time) || now(),
  };
}

function parseTimeoutSeconds(raw: unknown): number {
  return typeof raw === "number" ? Math.min(Math.max(Math.floor(raw), 0), 10) : 0;
}

function assertSessionOwner(
  session: { agentId: string; userId?: string },
  req: { agentId: string; userId: string },
): void {
  if (session.agentId !== req.agentId || (session.userId && session.userId !== req.userId)) {
    throw new SetupError("unauthorized", "login session does not belong to this requester");
  }
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
  const sdkOverride = opts.sdkOverride;

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
    assertSessionOwner(session, req);

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

  async function discover(
    req: DiscoverRequest,
    ctx: SetupContext,
  ): Promise<DiscoverResult> {
    const { state, session } = ctx.sessions.resolve(req.loginId);
    if (state === "missing") throw new SetupError("login_missing", "login id is unknown");
    if (state === "expired") throw new SetupError("login_expired", "login session expired");
    if (!session || session.provider !== "feishu") {
      throw new SetupError("login_missing", "login id is unknown");
    }
    assertSessionOwner(session, req);
    const { appId, appSecret, domain, userOpenId } = session.secretPayload;
    if (
      session.status !== "confirmed" ||
      !appId ||
      !appSecret ||
      !userOpenId
    ) {
      throw new SetupError("login_unconfirmed", "feishu login is not confirmed yet");
    }

    const chats = new Map<string, FeishuDiscoveredChat>();
    const dispatcher = createDiscoveryDispatcher();
    dispatcher.register({
      "im.message.receive_v1": (data: unknown) => {
        const discovered = discoveryChatFromEvent(
          data as FeishuMessageEvent,
          userOpenId,
          ctx.now,
        );
        if (!discovered) return;
        const previous = chats.get(discovered.chatId);
        chats.set(discovered.chatId, {
          ...previous,
          ...discovered,
          label: discovered.label ?? previous?.label ?? null,
          lastSeenAt: Math.max(previous?.lastSeenAt ?? 0, discovered.lastSeenAt),
        });
      },
    });
    const wsClient = createDiscoveryWsClient({
      appId,
      appSecret,
      domain: sdkDomain(domain),
    });
    try {
      const startFailure = Promise.resolve()
        .then(() => wsClient.start({ eventDispatcher: dispatcher }))
        .then(
          () => new Promise<never>(() => {}),
          (err) => Promise.reject(err),
        );
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      await Promise.race([startFailure, delay(0)]);
      await Promise.race([
        startFailure,
        delay(parseTimeoutSeconds(req.options?.timeoutSeconds) * 1000),
      ]);
    } catch (err) {
      ctx.log.warn("feishu discover failed", {
        agentId: req.agentId,
        loginId: req.loginId,
        err: redact(String(err), appSecret),
      });
      throw new SetupError("provider_unreachable", "feishu discovery endpoint unreachable");
    } finally {
      try {
        wsClient.close({ force: true });
      } catch {
        // best effort
      }
    }
    const values = [...chats.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((chat) => ({ ...chat }));
    return {
      candidates: values,
      chats: values,
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
    assertSessionOwner(session, req);
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

  function createDiscoveryDispatcher(): {
    register(handlers: Record<string, (data: unknown) => unknown>): void;
  } {
    if (sdkOverride) return sdkOverride.createDispatcher();
    const sdk = Lark as unknown as {
      EventDispatcher: new (args?: Record<string, unknown>) => {
        register(handlers: Record<string, (data: unknown) => unknown>): void;
      };
    };
    return new sdk.EventDispatcher({});
  }

  function createDiscoveryWsClient(args: Record<string, unknown>): {
    start(opts: unknown): unknown;
    close(opts?: unknown): unknown;
  } {
    if (sdkOverride) return sdkOverride.createWsClient(args);
    const sdk = Lark as unknown as {
      WSClient: new (args: Record<string, unknown>) => {
        start(opts: unknown): unknown;
        close(opts?: unknown): unknown;
      };
      LoggerLevel?: { info?: unknown };
    };
    return new sdk.WSClient({
      ...args,
      loggerLevel: sdk.LoggerLevel?.info,
    });
  }

  return {
    provider: "feishu",
    loginStart,
    loginStatus,
    discover,
    finalize,
    test,
  };
}

function redact(input: string, token?: string): string {
  if (!token) return input;
  return input.split(token).join("[REDACTED]");
}
