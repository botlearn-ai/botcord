/**
 * Telegram setup adapter.
 *
 * Telegram differs from WeChat/Feishu: there is no qrcode login. The
 * user pastes a bot token straight into the dashboard; we validate it
 * via `getMe`, discover chat/sender candidates via `getUpdates`, then
 * persist the token in the long-term secret store. To keep the HTTP
 * shape uniform across providers we map:
 *
 *   loginStart  → validate botToken (getMe), create a setup session
 *                 whose secretPayload holds the temporary token.
 *   loginStatus → synchronous "still ok?" check on the session — no
 *                 async confirmation step exists for Telegram.
 *   discover    → getUpdates → unique chat + sender candidate lists.
 *   finalize    → conflict-check (token fingerprint) → write secret +
 *                 connection → drop the setup session.
 *   test        → load secret → getMe.
 *
 * Bot token MUST NEVER appear in any response body, error message, or
 * log line. All Telegram error strings get scrubbed through
 * `redactToken` (Telegram embeds the token in the URL path, so raw
 * fetch errors routinely include it). Connection.config keeps only a
 * SHA-256 fingerprint of the token — never the plaintext — so we can
 * detect duplicate-token gateways at finalize time without ever
 * persisting the secret outside the secret store.
 */

import { createHash } from "node:crypto";

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
  type RotateSecretRequest,
  type RotateSecretResult,
  type SetupContext,
  type TestRequest,
  type TestResult,
} from "../types.js";
import { assertSafeBaseUrl, UnsafeBaseUrlError } from "../url-guard.js";

export const DEFAULT_TELEGRAM_BASE_URL = "https://api.telegram.org";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TelegramSetupAdapterOptions {
  fetchImpl?: FetchLike;
  /** Override the default Telegram base URL (e.g. for E2E against a stub). */
  baseUrl?: string;
  /** Override the wall clock used for setup-session expirations. Tests only. */
  now?: () => number;
}

interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export function createTelegramSetupAdapter(
  opts: TelegramSetupAdapterOptions = {},
): ProviderSetupAdapter {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const defaultBaseUrl = (opts.baseUrl ?? DEFAULT_TELEGRAM_BASE_URL).replace(/\/+$/, "");

  function redactToken(input: string, token?: string): string {
    if (!input) return input;
    if (!token) return input;
    return input.split(token).join("[REDACTED]");
  }

  function pickBaseUrl(reqBody: Record<string, unknown> | undefined): string {
    const raw =
      reqBody && typeof reqBody.baseUrl === "string" && reqBody.baseUrl.length > 0
        ? reqBody.baseUrl
        : undefined;
    if (!raw) return defaultBaseUrl;
    try {
      assertSafeBaseUrl(raw);
    } catch (err) {
      if (err instanceof UnsafeBaseUrlError) {
        throw new SetupError("bad_request", "baseUrl is not allowed");
      }
      throw err;
    }
    return raw.replace(/\/+$/, "");
  }

  function extractToken(body: Record<string, unknown> | undefined): string {
    const value =
      body && typeof body.botToken === "string"
        ? body.botToken
        : body && typeof body.bot_token === "string"
        ? (body.bot_token as string)
        : "";
    const token = value.trim();
    if (!token) {
      throw new SetupError("bad_request", "botToken is required");
    }
    return token;
  }

  async function callApi<T>(
    baseUrl: string,
    token: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<TelegramApiResult<T>> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: ac.signal,
      });
      let parsed: unknown = null;
      try {
        const raw = await res.text();
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as TelegramApiResult<T>;
      }
      // Treat HTTP-level errors with no JSON body as auth/unreachable
      // depending on status code.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return { ok: false, error_code: res.status, description: `HTTP ${res.status}` };
      }
      return { ok: false, description: `HTTP ${res.status}` };
    } finally {
      clearTimeout(timer);
    }
  }

  function tokenFingerprint(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  async function loginStart(
    req: LoginStartRequest,
    ctx: SetupContext,
  ): Promise<LoginStartResult> {
    const body = (req.options ?? {}) as Record<string, unknown>;
    const token = extractToken(body);
    const baseUrl = pickBaseUrl(body);

    let resp: TelegramApiResult<TelegramUser>;
    try {
      resp = await callApi<TelegramUser>(baseUrl, token, "getMe", {}, 5_000);
    } catch (err) {
      ctx.log.warn("telegram login/start getMe failed", {
        agentId: req.agentId,
        err: redactToken(String((err as Error)?.message ?? err), token),
      });
      throw new SetupError("provider_unreachable", "telegram getMe unreachable");
    }
    if (!resp.ok) {
      const code = resp.error_code;
      if (code === 401 || code === 403 || code === 404) {
        ctx.log.warn("telegram login/start invalid token", {
          agentId: req.agentId,
          code,
        });
        throw new SetupError("provider_auth_failed", "telegram bot token rejected");
      }
      ctx.log.warn("telegram login/start non-ok", {
        agentId: req.agentId,
        description: redactToken(resp.description ?? "", token),
      });
      throw new SetupError("provider_unreachable", "telegram getMe returned non-ok");
    }
    const me = resp.result ?? ({} as TelegramUser);
    const botInfo = sanitizeBotInfo(me);

    const loginId = mintLoginId("telegram");
    const session = ctx.sessions.create({
      loginId,
      agentId: req.agentId,
      ...(req.userId ? { userId: req.userId } : {}),
      provider: "telegram",
      // Telegram has no async confirm — getMe success IS confirmation.
      status: "confirmed",
      publicPayload: {
        tokenPreview: maskTokenPreview(token),
      },
      secretPayload: {
        telegramBotToken: token,
        baseUrl,
      },
    });

    return {
      loginId,
      expiresAt: session.expiresAt,
      publicPayload: {
        botInfo,
        tokenPreview: maskTokenPreview(token),
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
    if (!session || session.provider !== "telegram") {
      throw new SetupError("login_missing", "login id is unknown");
    }
    return {
      loginId: req.loginId,
      status: session.status,
      publicPayload: {
        ...(session.publicPayload.tokenPreview
          ? { tokenPreview: session.publicPayload.tokenPreview }
          : {}),
      },
      expiresAt: session.expiresAt,
    };
  }

  async function discover(
    req: DiscoverRequest,
    ctx: SetupContext,
  ): Promise<DiscoverResult> {
    const { state, session } = ctx.sessions.resolve(req.loginId);
    if (state === "missing") throw new SetupError("login_missing", "login id is unknown");
    if (state === "expired") throw new SetupError("login_expired", "login session expired");
    if (!session || session.provider !== "telegram") {
      throw new SetupError("login_missing", "login id is unknown");
    }
    const token = session.secretPayload.telegramBotToken;
    if (!token) {
      throw new SetupError("login_unconfirmed", "telegram bot token missing");
    }
    const baseUrl = session.secretPayload.baseUrl ?? defaultBaseUrl;

    let resp: TelegramApiResult<TelegramUpdate[]>;
    try {
      resp = await callApi<TelegramUpdate[]>(
        baseUrl,
        token,
        "getUpdates",
        { timeout: 0, limit: 100 },
        5_000,
      );
    } catch (err) {
      ctx.log.warn("telegram discover getUpdates failed", {
        agentId: req.agentId,
        loginId: req.loginId,
        err: redactToken(String((err as Error)?.message ?? err), token),
      });
      throw new SetupError("provider_unreachable", "telegram getUpdates unreachable");
    }
    if (!resp.ok) {
      ctx.log.warn("telegram discover non-ok", {
        agentId: req.agentId,
        loginId: req.loginId,
        description: redactToken(resp.description ?? "", token),
      });
      throw new SetupError("provider_unreachable", "telegram getUpdates returned non-ok");
    }

    const chats = new Map<string, Record<string, unknown>>();
    const senders = new Map<string, Record<string, unknown>>();
    for (const update of resp.result ?? []) {
      const msg =
        update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
      if (!msg) continue;
      if (msg.chat && typeof msg.chat.id === "number") {
        const id = String(msg.chat.id);
        if (!chats.has(id)) {
          chats.set(id, sanitizeChat(msg.chat));
        }
      }
      if (msg.from && typeof msg.from.id === "number") {
        const id = String(msg.from.id);
        if (!senders.has(id)) {
          senders.set(id, sanitizeSender(msg.from));
        }
      }
    }

    // Existing setup-server response shape expects `candidates`. Telegram
    // benefits from the two-list split, so we expose both fields and keep
    // `candidates` as a flat union for the generic shape.
    const chatList = [...chats.values()];
    const senderList = [...senders.values()];
    return {
      candidates: [
        ...chatList.map((c) => ({ kind: "chat", ...c })),
        ...senderList.map((s) => ({ kind: "sender", ...s })),
      ],
      // Provider-specific extras consumed by the dashboard.
      ...({ chats: chatList, senders: senderList } as Record<string, unknown>),
    } as DiscoverResult;
  }

  async function finalize(
    req: FinalizeRequest,
    ctx: SetupContext,
  ): Promise<FinalizeResult> {
    const { state, session } = ctx.sessions.resolve(req.loginId);
    if (state === "missing") throw new SetupError("login_missing", "login id is unknown");
    if (state === "expired") throw new SetupError("login_expired", "login session expired");
    if (!session || session.provider !== "telegram") {
      throw new SetupError("login_missing", "login id is unknown");
    }
    const token = session.secretPayload.telegramBotToken;
    if (!token) {
      throw new SetupError("login_unconfirmed", "telegram bot token missing");
    }
    const baseUrl = session.secretPayload.baseUrl ?? defaultBaseUrl;

    const cfg = (req.config ?? {}) as Record<string, unknown>;
    const allowedChatIds = sanitizeIdList(cfg.allowedChatIds, "allowedChatIds");
    const allowedSenderIds = sanitizeIdList(cfg.allowedSenderIds, "allowedSenderIds");

    // Conflict detection (§5.3 + §8 gateway_conflict + §11): identify the
    // bot token by its sha256 fingerprint and refuse if any other active
    // telegram connection already owns it. Two pollers on the same bot
    // token would fight over the getUpdates offset.
    const fingerprint = tokenFingerprint(token);
    for (const existing of ctx.store.listConnections()) {
      if (existing.provider !== "telegram") continue;
      if (!existing.enabled) continue;
      if (existing.status === "disabled") continue;
      const existingFp =
        typeof (existing.config as Record<string, unknown>).tokenFingerprint === "string"
          ? ((existing.config as Record<string, unknown>).tokenFingerprint as string)
          : undefined;
      if (existingFp && existingFp === fingerprint) {
        throw new SetupError(
          "gateway_conflict",
          "telegram bot token already bound to another gateway",
        );
      }
    }

    const gatewayId = mintGatewayId("telegram");
    ctx.secrets.write(gatewayId, {
      botToken: token,
      baseUrl,
    });

    const safeConfig: Record<string, unknown> = {
      baseUrl,
      allowedChatIds,
      allowedSenderIds,
      tokenFingerprint: fingerprint,
      ...(typeof cfg.splitAt === "number" ? { splitAt: cfg.splitAt } : {}),
    };

    const now = ctx.now();
    const enabled = req.enabled !== false;
    const connection: GatewayConnection = {
      id: gatewayId,
      agentId: req.agentId,
      ...(req.userId ? { userId: req.userId } : {}),
      provider: "telegram",
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

  async function rotateSecret(
    req: RotateSecretRequest,
    ctx: SetupContext,
  ): Promise<RotateSecretResult> {
    const conn = ctx.store.getConnection(req.gatewayId);
    if (!conn || conn.provider !== "telegram") {
      throw new SetupError("not_found", "gateway not found");
    }
    const rawToken =
      typeof req.secret.botToken === "string"
        ? req.secret.botToken
        : typeof req.secret.bot_token === "string"
          ? (req.secret.bot_token as string)
          : "";
    const newToken = rawToken.trim();
    if (!newToken) {
      throw new SetupError("bad_request", "botToken is required");
    }
    const stored = conn.secretRef
      ? ctx.secrets.load<{ botToken?: string; baseUrl?: string }>(conn.secretRef)
      : null;
    const baseUrl =
      typeof req.secret.baseUrl === "string" && req.secret.baseUrl.length > 0
        ? pickBaseUrl({ baseUrl: req.secret.baseUrl })
        : stored?.baseUrl ?? defaultBaseUrl;

    // Validate the new token live before mutating any state.
    let resp: TelegramApiResult<TelegramUser>;
    try {
      resp = await callApi<TelegramUser>(baseUrl, newToken, "getMe", {}, 5_000);
    } catch (err) {
      ctx.log.warn("telegram rotateSecret getMe failed", {
        gatewayId: req.gatewayId,
        err: redactToken(String((err as Error)?.message ?? err), newToken),
      });
      throw new SetupError("provider_unreachable", "telegram getMe unreachable");
    }
    if (!resp.ok) {
      const code = resp.error_code;
      if (code === 401 || code === 403 || code === 404) {
        throw new SetupError("provider_auth_failed", "telegram bot token rejected");
      }
      throw new SetupError("provider_unreachable", "telegram getMe returned non-ok");
    }

    // Conflict detection: refuse if any OTHER active telegram connection
    // already owns this token fingerprint. Self-rotation to the same token is
    // a no-op fingerprint match against the current row and is allowed.
    const fingerprint = tokenFingerprint(newToken);
    for (const existing of ctx.store.listConnections()) {
      if (existing.id === conn.id) continue;
      if (existing.provider !== "telegram") continue;
      if (!existing.enabled) continue;
      if (existing.status === "disabled") continue;
      const existingFp =
        typeof (existing.config as Record<string, unknown>).tokenFingerprint === "string"
          ? ((existing.config as Record<string, unknown>).tokenFingerprint as string)
          : undefined;
      if (existingFp && existingFp === fingerprint) {
        throw new SetupError(
          "gateway_conflict",
          "telegram bot token already bound to another gateway",
        );
      }
    }

    const secretRef = conn.secretRef ?? conn.id;
    ctx.secrets.write(secretRef, { botToken: newToken, baseUrl });
    return { configPatch: { tokenFingerprint: fingerprint, baseUrl } };
  }

  async function test(
    req: TestRequest,
    ctx: SetupContext,
  ): Promise<TestResult> {
    const conn = ctx.store.getConnection(req.gatewayId);
    if (!conn || conn.provider !== "telegram") {
      throw new SetupError("not_found", "gateway not found");
    }
    if (!conn.secretRef) {
      throw new SetupError("provider_auth_failed", "gateway missing secret reference");
    }
    const secret = ctx.secrets.load<{ botToken?: string; baseUrl?: string }>(conn.secretRef);
    const token = secret?.botToken;
    if (!token) {
      throw new SetupError("provider_auth_failed", "gateway missing bot token");
    }
    const baseUrl = secret?.baseUrl ?? defaultBaseUrl;
    try {
      const resp = await callApi<TelegramUser>(baseUrl, token, "getMe", {}, 5_000);
      if (!resp.ok) return { ok: false, details: { code: resp.error_code ?? 0 } };
      return { ok: true, details: { botInfo: sanitizeBotInfo(resp.result ?? ({} as TelegramUser)) } };
    } catch (err) {
      ctx.log.warn("telegram test failed", {
        gatewayId: req.gatewayId,
        err: redactToken(String((err as Error)?.message ?? err), token),
      });
      return { ok: false };
    }
  }

  return {
    provider: "telegram",
    loginStart,
    loginStatus,
    discover,
    finalize,
    test,
    rotateSecret,
  };
}

function sanitizeBotInfo(me: TelegramUser): Record<string, unknown> {
  return {
    id: typeof me.id === "number" ? me.id : undefined,
    is_bot: typeof me.is_bot === "boolean" ? me.is_bot : undefined,
    ...(typeof me.username === "string" ? { username: me.username } : {}),
    ...(typeof me.first_name === "string" ? { first_name: me.first_name } : {}),
    ...(typeof me.last_name === "string" ? { last_name: me.last_name } : {}),
  };
}

function sanitizeChat(chat: TelegramChat): Record<string, unknown> {
  return {
    id: String(chat.id),
    ...(typeof chat.type === "string" ? { type: chat.type } : {}),
    ...(typeof chat.title === "string" ? { title: chat.title } : {}),
    ...(typeof chat.username === "string" ? { username: chat.username } : {}),
    ...(typeof chat.first_name === "string" ? { first_name: chat.first_name } : {}),
    ...(typeof chat.last_name === "string" ? { last_name: chat.last_name } : {}),
  };
}

function sanitizeSender(user: TelegramUser): Record<string, unknown> {
  return {
    id: String(user.id),
    ...(typeof user.username === "string" ? { username: user.username } : {}),
    ...(typeof user.first_name === "string" ? { first_name: user.first_name } : {}),
    ...(typeof user.last_name === "string" ? { last_name: user.last_name } : {}),
  };
}

function sanitizeIdList(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new SetupError("bad_request", `${field} must be an array of ids`);
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.length > 0) {
      out.push(v);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out.push(String(v));
    } else {
      throw new SetupError("bad_request", `${field} entries must be strings or numeric ids`);
    }
  }
  return out;
}

