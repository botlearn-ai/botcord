/**
 * Daemon-side handlers for the third-party gateway control frames defined
 * in `packages/protocol-core/src/control-frame.ts`. Kept separate from
 * `provision.ts` so the BotCord-agent provisioning logic and the third-
 * party adapter management stay independently testable.
 *
 * All handlers take a {@link GatewayControlContext} so callers can swap the
 * gateway, login-session store, fetch impl, and config I/O — `provision.ts`
 * wires the production defaults.
 */

import type { ControlAck } from "@botcord/protocol-core";
import type { Gateway, GatewayChannelConfig } from "./gateway/index.js";
import {
  loadConfig,
  saveConfig,
  resolveConfiguredAgentIds,
  type DaemonConfig,
  type ThirdPartyGatewayProfile,
} from "./config.js";
import {
  deleteGatewaySecret,
  loadGatewaySecret,
  saveGatewaySecret,
} from "./gateway/channels/secret-store.js";
import {
  LoginSessionStore,
  maskTokenPreview,
  mintLoginId,
} from "./gateway/channels/login-session.js";
import {
  DEFAULT_WECHAT_BASE_URL,
  getBotQrcode,
  getQrcodeStatus,
} from "./gateway/channels/wechat-login.js";
import { assertSafeBaseUrl, UnsafeBaseUrlError } from "./gateway/channels/url-guard.js";
import { log as daemonLog } from "./log.js";
// W7: canonical FetchLike lives in gateway/channels/http-types.ts so the
// daemon and the WeChat adapter can't drift on the shape.
import type { FetchLike } from "./gateway/channels/http-types.js";

type AckBody = Omit<ControlAck, "id">;

type GatewayProvider = "telegram" | "wechat";

interface GatewayProfileSummary {
  id: string;
  type: GatewayProvider;
  accountId: string;
  label?: string;
  enabled: boolean;
  baseUrl?: string;
  allowedSenderIds?: string[];
  allowedChatIds?: string[];
  splitAt?: number;
  status?: {
    running: boolean;
    connected?: boolean;
    authorized?: boolean;
    lastPollAt?: number;
    lastInboundAt?: number;
    lastSendAt?: number;
    lastError?: string | null;
  };
}

interface ListGatewaysResult {
  gateways: GatewayProfileSummary[];
}

interface UpsertGatewayParams {
  id: string;
  type: GatewayProvider;
  accountId: string;
  label?: string;
  enabled?: boolean;
  loginId?: string;
  secret?: {
    botToken?: string;
  };
  settings?: {
    baseUrl?: string;
    allowedSenderIds?: string[];
    allowedChatIds?: string[];
    splitAt?: number;
  };
}

interface UpsertGatewayResult {
  id: string;
  type: GatewayProvider;
  accountId: string;
  enabled: boolean;
  tokenPreview?: string;
  status?: GatewayProfileSummary["status"];
}

interface RemoveGatewayParams {
  id: string;
  deleteSecret?: boolean;
}

interface RemoveGatewayResult {
  id: string;
  removed: boolean;
  secretDeleted: boolean;
}

interface TestGatewayParams {
  id: string;
}

interface TestGatewayResult {
  id: string;
  ok: boolean;
  info?: Record<string, unknown>;
  error?: string;
}

interface GatewayLoginStartParams {
  provider: GatewayProvider;
  accountId: string;
  gatewayId?: string;
  baseUrl?: string;
}

interface GatewayLoginStartResult {
  loginId: string;
  qrcode?: string;
  qrcodeUrl?: string;
  expiresAt: number;
}

interface GatewayLoginStatusParams {
  provider: GatewayProvider;
  loginId: string;
  accountId: string;
}

interface GatewayLoginStatusResult {
  status: "pending" | "scanned" | "confirmed" | "expired" | "failed";
  baseUrl?: string;
  tokenPreview?: string;
}

export type { FetchLike };

export interface GatewayControlContext {
  gateway: Gateway;
  /** Override `loadConfig`/`saveConfig`. Tests pass an in-memory pair. */
  configIO?: {
    load: () => DaemonConfig;
    save: (cfg: DaemonConfig) => void;
  };
  /** Shared login-session store. Created lazily when not supplied. */
  loginSessions?: LoginSessionStore;
  /**
   * Override the iLink HTTP client. Defaults to the helpers in
   * `wechat-login.ts` (which themselves read `globalThis.fetch`).
   */
  wechatLoginClient?: {
    getBotQrcode: typeof getBotQrcode;
    getQrcodeStatus: typeof getQrcodeStatus;
  };
  /** Override the global fetch — used by `test_gateway` for Telegram getMe. */
  fetchImpl?: FetchLike;
}

/**
 * Build a closure carrying the production / test defaults. Returned object
 * exposes one `handle*` method per frame type so `provision.ts` can route by
 * `frame.type` without re-resolving dependencies on every dispatch.
 */
export function createGatewayControl(ctx: GatewayControlContext) {
  const cfgIO = ctx.configIO ?? { load: loadConfig, save: saveConfig };
  const sessions = ctx.loginSessions ?? new LoginSessionStore();
  const wechatLogin = ctx.wechatLoginClient ?? { getBotQrcode, getQrcodeStatus };
  // W7: validate fetch availability at construction so a missing global is
  // diagnosed at startup, not during the first control frame. Tests inject
  // `ctx.fetchImpl` explicitly and bypass the global lookup entirely.
  let fetchImpl: FetchLike;
  if (ctx.fetchImpl) {
    fetchImpl = ctx.fetchImpl;
  } else {
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    if (typeof globalFetch !== "function") {
      throw new Error(
        "createGatewayControl: globalThis.fetch is not available (Node ≥18 required) and no ctx.fetchImpl was supplied",
      );
    }
    const bound = (globalFetch as (...a: unknown[]) => unknown).bind(globalThis);
    fetchImpl = ((input, init) => (bound as FetchLike)(input, init)) as FetchLike;
  }

  // --- list_gateways ------------------------------------------------------
  function handleList(): AckBody {
    const cfg = cfgIO.load();
    const channelStatus = ctx.gateway.snapshot().channels;
    const profiles = cfg.thirdPartyGateways ?? [];
    const gateways: GatewayProfileSummary[] = profiles.map((p) =>
      annotateProfile(p, channelStatus[p.id]),
    );
    const result: ListGatewaysResult = { gateways };
    return { ok: true, result };
  }

  // --- upsert_gateway -----------------------------------------------------
  async function handleUpsert(params: UpsertGatewayParams): Promise<AckBody> {
    const err = validateUpsertParams(params);
    if (err) return badParams(err);
    // W1: defense-in-depth — Hub already screens baseUrl; reject again here
    // so a compromised control plane cannot pivot the daemon to internal IPs.
    try {
      assertSafeBaseUrl(params.settings?.baseUrl);
    } catch (urlErr) {
      if (urlErr instanceof UnsafeBaseUrlError) return badParams(urlErr.message);
      throw urlErr;
    }

    const cfg = cfgIO.load();

    // accountId must belong to a daemon-bound agent. An empty agent set
    // (no agents provisioned yet) is itself a hard reject — otherwise we
    // would silently accept upserts against a daemon that has nowhere to
    // route their inbound messages.
    const agentIds = new Set(resolveConfiguredAgentIds(cfg) ?? []);
    if (!agentIds.has(params.accountId)) {
      return {
        ok: false,
        error: {
          code: "unknown_account",
          message: `accountId "${params.accountId}" is not bound to this daemon`,
        },
      };
    }

    // Provider-specific secret resolution.
    let botToken: string | undefined;
    if (params.type === "telegram") {
      botToken = params.secret?.botToken;
      if (!botToken) {
        // Allow updates that only flip enabled/whitelist — only require a
        // token when none is on disk yet.
        const existing = loadGatewaySecret<{ botToken?: string }>(params.id);
        if (!existing?.botToken) {
          return badParams("upsert_gateway: telegram requires secret.botToken on first install");
        }
        botToken = existing.botToken;
      }
    } else if (params.type === "wechat") {
      const loginId = params.loginId;
      if (!loginId) {
        return badParams("upsert_gateway: wechat requires loginId");
      }
      const session = sessions.get(loginId);
      if (!session) {
        return {
          ok: false,
          error: { code: "login_expired", message: `wechat login session "${loginId}" not found or expired` },
        };
      }
      if (session.provider !== "wechat") {
        return badParams(`upsert_gateway: login session provider "${session.provider}" != "wechat"`);
      }
      if (session.accountId !== params.accountId) {
        return {
          ok: false,
          error: {
            code: "login_account_mismatch",
            message: "wechat login session accountId does not match upsert request",
          },
        };
      }
      if (!session.botToken) {
        return {
          ok: false,
          error: { code: "login_unconfirmed", message: "wechat login session has no bot token yet" },
        };
      }
      botToken = session.botToken;
      // Bind the session to its eventual gateway id for forensic logging.
      sessions.update(loginId, { gatewayId: params.id });
    } else {
      return badParams(`upsert_gateway: unknown provider "${(params as { type: string }).type}"`);
    }

    // W3/W6: remember whether a profile already exists for this id BEFORE we
    // write the secret/config. For UPDATE path, capture previous profile +
    // previous secret so addChannel failure can restore prior state.
    const existingProfiles = cfg.thirdPartyGateways ?? [];
    const hadExistingProfile = existingProfiles.some((g) => g.id === params.id);
    const prevProfile = existingProfiles.find((g) => g.id === params.id);
    // W6: load the previous secret for UPDATE rollback BEFORE overwriting.
    const prevSecret = hadExistingProfile
      ? loadGatewaySecret<{ botToken?: string }>(params.id)
      : null;

    // Persist secret first (so a config write that succeeds is never
    // followed by a missing-secret crash). Atomic rename inside saveSecret.
    const secretFile = saveGatewaySecret(params.id, { botToken });

    // Update or insert the third-party gateway profile in config.
    const enabled = params.enabled !== false;
    const next = upsertProfileInConfig(cfg, {
      id: params.id,
      type: params.type,
      accountId: params.accountId,
      label: params.label,
      enabled,
      baseUrl: params.settings?.baseUrl,
      allowedSenderIds: params.settings?.allowedSenderIds,
      allowedChatIds: params.settings?.allowedChatIds,
      splitAt: params.settings?.splitAt,
    });
    cfgIO.save(next);

    // Hot-plug. removeChannel is a no-op when the id isn't registered, so
    // calling it unconditionally lets us swap secrets/settings in place.
    if (enabled) {
      try {
        await ctx.gateway.removeChannel(params.id, "upsert_gateway");
      } catch {
        // best-effort
      }
      try {
        await ctx.gateway.addChannel(buildChannelConfig(params, secretFile));
      } catch (addErr) {
        const message = addErr instanceof Error ? addErr.message : String(addErr);
        daemonLog.warn("upsert_gateway.addChannel failed", { id: params.id, error: message });
        if (!hadExistingProfile) {
          // W3: fresh install — delete the orphan secret so nothing references it.
          try {
            deleteGatewaySecret(params.id);
          } catch {
            // best-effort
          }
        } else {
          // W6: UPDATE path — restore previous secret + profile + try to re-add
          // the channel with the old config.
          try {
            if (prevSecret) saveGatewaySecret(params.id, prevSecret);
          } catch {
            // best-effort
          }
          try {
            if (prevProfile) {
              cfgIO.save(upsertProfileInConfig(cfgIO.load(), prevProfile));
            }
          } catch {
            // best-effort
          }
          try {
            if (prevProfile && prevSecret?.botToken) {
              await ctx.gateway.addChannel(
                buildChannelConfig(
                  {
                    ...params,
                    type: prevProfile.type as typeof params.type,
                    enabled: prevProfile.enabled !== false,
                    secret: { botToken: prevSecret.botToken },
                    settings: {
                      baseUrl: prevProfile.baseUrl,
                      allowedSenderIds: prevProfile.allowedSenderIds,
                      allowedChatIds: prevProfile.allowedChatIds,
                      splitAt: prevProfile.splitAt,
                    },
                  },
                  secretFile,
                ),
              );
            }
          } catch {
            // Restore also failed — surface structured error.
            return {
              ok: false,
              error: {
                code: "addChannel_failed",
                message: "channel down, manual recovery needed",
              },
            };
          }
        }
        return {
          ok: false,
          error: { code: "addChannel_failed", message },
        };
      }
    } else {
      // enabled=false: stop the channel if it was running but keep the secret.
      try {
        await ctx.gateway.removeChannel(params.id, "upsert_gateway disabled");
      } catch {
        // best-effort
      }
    }

    const liveStatus = ctx.gateway.snapshot().channels[params.id];
    const result: UpsertGatewayResult = {
      id: params.id,
      type: params.type,
      accountId: params.accountId,
      enabled,
      tokenPreview: maskTokenPreview(botToken),
      ...(liveStatus ? { status: pickStatus(liveStatus) } : {}),
    };
    daemonLog.info("upsert_gateway applied", {
      id: params.id,
      type: params.type,
      enabled,
    });
    return { ok: true, result };
  }

  // --- remove_gateway -----------------------------------------------------
  async function handleRemove(params: RemoveGatewayParams): Promise<AckBody> {
    if (!params.id || typeof params.id !== "string") {
      return badParams("remove_gateway: id is required");
    }
    // W6: stop the channel BEFORE deleting the secret. An orphaned secret on
    // disk is recoverable; a running poll loop holding a live token after the
    // operator clicked "remove" is not. Re-throw on stop failure so the Hub
    // surfaces the error and the operator can retry.
    try {
      await ctx.gateway.removeChannel(params.id, "remove_gateway");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      daemonLog.warn("remove_gateway.removeChannel failed — keeping secret", {
        id: params.id,
        error: message,
      });
      return {
        ok: false,
        error: { code: "removeChannel_failed", message },
      };
    }

    const cfg = cfgIO.load();
    const before = cfg.thirdPartyGateways ?? [];
    const after = before.filter((g) => g.id !== params.id);
    if (after.length !== before.length) {
      cfgIO.save({ ...cfg, thirdPartyGateways: after });
    }

    let secretDeleted = false;
    if (params.deleteSecret !== false) {
      try {
        deleteGatewaySecret(params.id);
        secretDeleted = true;
      } catch (err) {
        daemonLog.warn("remove_gateway.deleteSecret failed", {
          id: params.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const result: RemoveGatewayResult = {
      id: params.id,
      removed: after.length !== before.length,
      secretDeleted,
    };
    daemonLog.info("remove_gateway applied", { id: params.id, secretDeleted });
    return { ok: true, result };
  }

  // --- test_gateway -------------------------------------------------------
  async function handleTest(params: TestGatewayParams): Promise<AckBody> {
    if (!params.id || typeof params.id !== "string") {
      return badParams("test_gateway: id is required");
    }
    const cfg = cfgIO.load();
    const profile = (cfg.thirdPartyGateways ?? []).find((g) => g.id === params.id);
    if (!profile) {
      return {
        ok: false,
        error: { code: "unknown_gateway", message: `no gateway with id "${params.id}"` },
      };
    }

    if (profile.type === "telegram") {
      const secret = loadGatewaySecret<{ botToken?: string }>(profile.id, profile.secretFile);
      const token = secret?.botToken;
      if (!token) {
        const result: TestGatewayResult = { id: profile.id, ok: false, error: "missing bot token" };
        return { ok: true, result };
      }
      const baseUrl = (profile.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
      try {
        const res = await fetchImpl(`${baseUrl}/bot${token}/getMe`, { method: "GET" });
        const body = JSON.parse(await res.text()) as { ok?: boolean; result?: Record<string, unknown>; description?: string };
        if (!body.ok) {
          const result: TestGatewayResult = {
            id: profile.id,
            ok: false,
            error: body.description ?? `telegram getMe returned ok=false`,
          };
          return { ok: true, result };
        }
        const result: TestGatewayResult = { id: profile.id, ok: true, info: body.result ?? {} };
        return { ok: true, result };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const redacted = raw.split(token).join("***");
        const result: TestGatewayResult = {
          id: profile.id,
          ok: false,
          error: redacted,
        };
        return { ok: true, result };
      }
    }

    // WeChat: iLink has no no-side-effect probe today. Fall back to the
    // adapter's last poll snapshot. `authorized === true` means the secret
    // is loaded and at least one poll succeeded.
    const snap = ctx.gateway.snapshot().channels[profile.id];
    const result: TestGatewayResult = snap
      ? {
          id: profile.id,
          ok: snap.running === true && snap.authorized !== false && !snap.lastError,
          info: {
            lastPollAt: snap.lastPollAt ?? null,
            lastInboundAt: snap.lastInboundAt ?? null,
            authorized: snap.authorized ?? null,
          },
          ...(snap.lastError ? { error: snap.lastError } : {}),
        }
      : { id: profile.id, ok: false, error: "wechat channel not running" };
    return { ok: true, result };
  }

  // --- gateway_login_start ------------------------------------------------
  async function handleLoginStart(params: GatewayLoginStartParams): Promise<AckBody> {
    if (!isProvider(params.provider)) {
      return badParams(`gateway_login_start: unknown provider "${String(params.provider)}"`);
    }
    if (!params.accountId || typeof params.accountId !== "string") {
      return badParams("gateway_login_start: accountId is required");
    }
    if (params.provider !== "wechat") {
      // Telegram has no qrcode flow; surface a clear error so the dashboard
      // can fall through to the token form.
      return badParams(`gateway_login_start: provider "${params.provider}" does not require login`);
    }
    // W1: SSRF guard — `baseUrl` flows directly into an authenticated fetch.
    try {
      assertSafeBaseUrl(params.baseUrl);
    } catch (urlErr) {
      if (urlErr instanceof UnsafeBaseUrlError) return badParams(urlErr.message);
      throw urlErr;
    }
    const baseUrl = params.baseUrl ?? DEFAULT_WECHAT_BASE_URL;
    let qrcode: string;
    let qrcodeUrl: string | undefined;
    try {
      const r = await wechatLogin.getBotQrcode({ baseUrl });
      qrcode = r.qrcode;
      qrcodeUrl = r.qrcodeUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      daemonLog.warn("gateway_login_start.getBotQrcode failed", { error: message });
      return {
        ok: false,
        error: { code: "provider_unreachable", message },
      };
    }
    const loginId = mintLoginId("wechat");
    const session = sessions.create({
      loginId,
      accountId: params.accountId,
      ...(params.gatewayId ? { gatewayId: params.gatewayId } : {}),
      provider: "wechat",
      qrcode,
      ...(qrcodeUrl ? { qrcodeUrl } : {}),
      baseUrl,
    });
    const result: GatewayLoginStartResult = {
      loginId,
      qrcode,
      ...(qrcodeUrl ? { qrcodeUrl } : {}),
      expiresAt: session.expiresAt,
    };
    daemonLog.info("gateway_login_start", { provider: "wechat", loginId, accountId: params.accountId });
    return { ok: true, result };
  }

  // --- gateway_login_status -----------------------------------------------
  async function handleLoginStatus(params: GatewayLoginStatusParams): Promise<AckBody> {
    if (!isProvider(params.provider)) {
      return badParams(`gateway_login_status: unknown provider "${String(params.provider)}"`);
    }
    if (!params.loginId) {
      return badParams("gateway_login_status: loginId is required");
    }
    if (!params.accountId || typeof params.accountId !== "string") {
      return badParams("gateway_login_status: accountId is required");
    }
    const session = sessions.get(params.loginId);
    if (!session) {
      const result: GatewayLoginStatusResult = { status: "expired" };
      return { ok: true, result };
    }
    if (session.provider !== params.provider) {
      return badParams("gateway_login_status: provider does not match login session");
    }
    // W4: accountId ownership check — prevent one user from polling another's login session.
    if (session.accountId !== params.accountId) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: "gateway_login_status: accountId does not match login session",
        },
      };
    }
    // If we already saw `confirmed`, return cached result so re-polling
    // doesn't keep hitting iLink.
    if (session.botToken) {
      const result: GatewayLoginStatusResult = {
        status: "confirmed",
        ...(session.baseUrl ? { baseUrl: session.baseUrl } : {}),
        tokenPreview: session.tokenPreview ?? maskTokenPreview(session.botToken),
      };
      return { ok: true, result };
    }
    if (params.provider !== "wechat") {
      // Future provider hook — today only WeChat poll path exists.
      return badParams(`gateway_login_status: provider "${params.provider}" not supported`);
    }
    if (!session.qrcode) {
      return {
        ok: false,
        error: { code: "no_qrcode", message: "login session has no qrcode to poll" },
      };
    }
    let probe: Awaited<ReturnType<typeof getQrcodeStatus>>;
    try {
      probe = await wechatLogin.getQrcodeStatus(session.qrcode, { baseUrl: session.baseUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      daemonLog.warn("gateway_login_status.getQrcodeStatus failed", { error: message });
      return {
        ok: false,
        error: { code: "provider_unreachable", message },
      };
    }
    const status = mapWechatStatus(probe.status);
    if (status === "confirmed" && probe.botToken) {
      const baseUrl = probe.baseUrl ?? session.baseUrl;
      const tokenPreview = maskTokenPreview(probe.botToken);
      sessions.update(params.loginId, {
        botToken: probe.botToken,
        ...(baseUrl ? { baseUrl } : {}),
        tokenPreview,
      });
      const result: GatewayLoginStatusResult = {
        status: "confirmed",
        ...(baseUrl ? { baseUrl } : {}),
        tokenPreview,
      };
      return { ok: true, result };
    }
    const result: GatewayLoginStatusResult = { status };
    return { ok: true, result };
  }

  return {
    handleList,
    handleUpsert,
    handleRemove,
    handleTest,
    handleLoginStart,
    handleLoginStatus,
    /** Exposed for tests — direct access to the in-memory session map. */
    _sessions: sessions,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badParams(message: string): AckBody {
  return { ok: false, error: { code: "bad_params", message } };
}

function isProvider(p: unknown): p is GatewayProvider {
  return p === "telegram" || p === "wechat";
}

function validateUpsertParams(p: UpsertGatewayParams): string | null {
  if (!p.id || typeof p.id !== "string") return "upsert_gateway: id is required";
  if (!isProvider(p.type)) return `upsert_gateway: unknown provider "${String(p.type)}"`;
  if (!p.accountId || typeof p.accountId !== "string") return "upsert_gateway: accountId is required";
  return null;
}

function annotateProfile(
  p: ThirdPartyGatewayProfile,
  status: import("./gateway/index.js").ChannelStatusSnapshot | undefined,
): GatewayProfileSummary {
  return {
    id: p.id,
    type: p.type,
    accountId: p.accountId,
    ...(p.label !== undefined ? { label: p.label } : {}),
    enabled: p.enabled !== false,
    ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
    ...(p.allowedSenderIds !== undefined ? { allowedSenderIds: p.allowedSenderIds } : {}),
    ...(p.allowedChatIds !== undefined ? { allowedChatIds: p.allowedChatIds } : {}),
    ...(p.splitAt !== undefined ? { splitAt: p.splitAt } : {}),
    ...(status ? { status: pickStatus(status) } : {}),
  };
}

function pickStatus(
  s: import("./gateway/index.js").ChannelStatusSnapshot,
): NonNullable<GatewayProfileSummary["status"]> {
  return {
    running: s.running === true,
    ...(typeof s.connected === "boolean" ? { connected: s.connected } : {}),
    ...(typeof s.authorized === "boolean" ? { authorized: s.authorized } : {}),
    ...(typeof s.lastPollAt === "number" ? { lastPollAt: s.lastPollAt } : {}),
    ...(typeof s.lastInboundAt === "number" ? { lastInboundAt: s.lastInboundAt } : {}),
    ...(typeof s.lastSendAt === "number" ? { lastSendAt: s.lastSendAt } : {}),
    ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
  };
}

function upsertProfileInConfig(
  cfg: DaemonConfig,
  patch: ThirdPartyGatewayProfile,
): DaemonConfig {
  const list = (cfg.thirdPartyGateways ?? []).slice();
  const idx = list.findIndex((g) => g.id === patch.id);
  // Drop undefined fields so a partial patch doesn't blow away existing
  // values (e.g. label not changing on an enabled-only flip).
  const compact = compactProfile(patch);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...compact };
  } else {
    list.push(compact);
  }
  return { ...cfg, thirdPartyGateways: list };
}

function compactProfile(p: ThirdPartyGatewayProfile): ThirdPartyGatewayProfile {
  const out: ThirdPartyGatewayProfile = {
    id: p.id,
    type: p.type,
    accountId: p.accountId,
  };
  if (p.label !== undefined) out.label = p.label;
  if (p.enabled !== undefined) out.enabled = p.enabled;
  if (p.baseUrl !== undefined) out.baseUrl = p.baseUrl;
  if (p.allowedSenderIds !== undefined) out.allowedSenderIds = p.allowedSenderIds;
  if (p.allowedChatIds !== undefined) out.allowedChatIds = p.allowedChatIds;
  if (p.splitAt !== undefined) out.splitAt = p.splitAt;
  if (p.secretFile !== undefined) out.secretFile = p.secretFile;
  if (p.stateFile !== undefined) out.stateFile = p.stateFile;
  return out;
}

function buildChannelConfig(
  params: UpsertGatewayParams,
  secretFile: string,
): GatewayChannelConfig {
  const ch: GatewayChannelConfig = {
    id: params.id,
    type: params.type,
    accountId: params.accountId,
    secretFile,
  };
  if (params.label !== undefined) ch.label = params.label;
  const s = params.settings ?? {};
  if (s.baseUrl !== undefined) ch.baseUrl = s.baseUrl;
  if (s.allowedSenderIds !== undefined) ch.allowedSenderIds = s.allowedSenderIds;
  if (s.allowedChatIds !== undefined) ch.allowedChatIds = s.allowedChatIds;
  if (s.splitAt !== undefined) ch.splitAt = s.splitAt;
  return ch;
}

/**
 * Translate iLink's qrcode status string into our public enum. iLink uses
 * lowercase variants (`pending`, `scaned`/`scanned`, `confirmed`, `expired`),
 * and we collapse anything unrecognized to `failed` so callers can surface a
 * concrete state.
 */
function mapWechatStatus(raw: string): GatewayLoginStatusResult["status"] {
  const v = raw.toLowerCase();
  if (v === "confirmed" || v === "ok" || v === "success") return "confirmed";
  if (v === "scanned" || v === "scaned") return "scanned";
  if (v === "pending" || v === "waiting") return "pending";
  if (v === "expired" || v === "timeout") return "expired";
  return "failed";
}
