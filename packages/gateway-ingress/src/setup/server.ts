/**
 * Internal setup HTTP server for the cloud gateway ingress.
 *
 * Routes (all prefixed `/internal/gateway-ingress/`):
 *
 *   POST   /agents/{agentId}/gateways/{provider}/login/start
 *   POST   /agents/{agentId}/gateways/{provider}/login/status
 *   POST   /agents/{agentId}/gateways/{provider}/discover
 *   POST   /agents/{agentId}/gateways/{provider}/senders
 *   POST   /agents/{agentId}/gateways
 *   PATCH  /agents/{agentId}/gateways/{gatewayId}
 *   DELETE /agents/{agentId}/gateways/{gatewayId}
 *   POST   /agents/{agentId}/gateways/{gatewayId}/test
 *
 * Auth: every request MUST carry either
 *   Authorization: Bearer <BOTCORD_INGRESS_SECRET>
 * or
 *   X-Ingress-Secret: <BOTCORD_INGRESS_SECRET>
 * compared in constant time. Failure → 401.
 *
 * Errors use `SetupError` from `./types.js`; the response body shape
 * is always `{ ok: false, error: { code, message } }` with `message`
 * redacted so provider secrets never leak.
 *
 * The server uses `node:http` directly to keep dependencies minimal
 * (mirrors `health.ts`).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import type { RuntimeGatewayProvider } from "@botcord/protocol-core";

import type { IngressLogger } from "../log.js";
import type { ProviderRunner } from "../provider-runner.js";
import type { IngressSecretStore } from "../storage/secrets.js";
import type { IngressStore } from "../storage/store.js";
import type { GatewayConnection } from "../types.js";

import type { IngressSetupSessionStore } from "./sessions.js";
import {
  SetupError,
  type ProviderSetupAdapter,
  type SetupContext,
  type SetupErrorCode,
  type SetupRequestContext,
} from "./types.js";

export interface SetupServerOptions {
  host: string;
  port: number;
  ingressSecret: string;
  sessions: IngressSetupSessionStore;
  secrets: IngressSecretStore;
  store: IngressStore;
  runner: ProviderRunner;
  log: IngressLogger;
  adapters: Record<string, ProviderSetupAdapter>;
  now?: () => number;
}

export interface SetupServer {
  url: string;
  close(): Promise<void>;
}

const SUPPORTED_PROVIDERS: Set<RuntimeGatewayProvider> = new Set(["wechat", "feishu", "telegram"]);
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB; setup payloads are small.

export async function startSetupServer(opts: SetupServerOptions): Promise<SetupServer> {
  const now = opts.now ?? (() => Date.now());
  const ctx: SetupContext = {
    sessions: opts.sessions,
    secrets: opts.secrets,
    store: opts.store,
    log: opts.log,
    now,
  };

  const server: Server = createServer((req, res) => {
    handle(req, res, opts, ctx).catch((err) => {
      opts.log.error("setup server unhandled error", { err: redact(String(err)) });
      sendError(res, new SetupError("internal", "internal server error"));
    });
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(`http://${opts.host}:${addr.port}`);
      } else {
        resolve(`http://${opts.host}:${opts.port}`);
      }
    });
  });

  opts.log.info("ingress setup server", { url });

  return {
    url,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SetupServerOptions,
  ctx: SetupContext,
): Promise<void> {
  if (!checkAuth(req, opts.ingressSecret)) {
    sendError(res, new SetupError("unauthorized", "missing or invalid ingress secret"));
    return;
  }

  const urlPath = (req.url ?? "").split("?")[0] ?? "";
  const PREFIX = "/internal/gateway-ingress/";
  if (!urlPath.startsWith(PREFIX)) {
    sendError(res, new SetupError("not_found", "unknown path"));
    return;
  }
  const tail = urlPath.slice(PREFIX.length).replace(/\/+$/, "");
  const parts = tail.split("/").filter((s) => s.length > 0);

  const method = (req.method ?? "GET").toUpperCase();

  try {
    // POST /agents/{agentId}/gateways/{provider}/login/start | status
    // POST /agents/{agentId}/gateways/{provider}/discover
    if (
      parts.length === 6 &&
      parts[0] === "agents" &&
      parts[2] === "gateways" &&
      (parts[4] === "login" || parts[4] === "discover") &&
      method === "POST"
    ) {
      // Already handled by 5-segment match below; this case is for login/start
      // with sub-path. Fall through.
    }

    // POST /agents/{agentId}/gateways/{provider}/login/{action}
    if (
      parts.length === 6 &&
      parts[0] === "agents" &&
      parts[2] === "gateways" &&
      parts[4] === "login" &&
      method === "POST"
    ) {
      const agentId = parts[1]!;
      const provider = parts[3] as RuntimeGatewayProvider;
      const action = parts[5]!;
      const body = await readJsonBody(req);
      const reqCtx = parseRequestContext(body, agentId);
      const adapter = requireAdapter(opts.adapters, provider);
      if (action === "start") {
        if (!adapter.loginStart) throw new SetupError("not_found", "loginStart not supported");
        // Merge provider-specific top-level fields into `options` so
        // adapters can accept e.g. `{botToken, baseUrl}` directly in the
        // request body without an extra nesting level. Context keys are
        // already consumed by `parseRequestContext`.
        const merged = mergeStartOptions(body);
        const out = await adapter.loginStart({ ...reqCtx, options: merged }, ctx);
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (action === "status") {
        if (!adapter.loginStatus) throw new SetupError("not_found", "loginStatus not supported");
        const loginId = requireString(body, "loginId");
        const out = await adapter.loginStatus({ ...reqCtx, loginId }, ctx);
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      throw new SetupError("not_found", "unknown login action");
    }

    // POST /agents/{agentId}/gateways/{provider}/discover
    // POST /agents/{agentId}/gateways/{provider}/senders
    if (
      parts.length === 5 &&
      parts[0] === "agents" &&
      parts[2] === "gateways" &&
      (parts[4] === "discover" || parts[4] === "senders") &&
      method === "POST"
    ) {
      const agentId = parts[1]!;
      const provider = parts[3] as RuntimeGatewayProvider;
      const body = await readJsonBody(req);
      const reqCtx = parseRequestContext(body, agentId);
      const adapter = requireAdapter(opts.adapters, provider);
      if (!adapter.discover) throw new SetupError("not_found", "discover not supported");
      const loginId = requireString(body, "loginId");
      const out = await adapter.discover(
        { ...reqCtx, loginId, options: pick(body, "options") },
        ctx,
      );
      sendJson(res, 200, { ok: true, ...out });
      return;
    }

    // POST /agents/{agentId}/gateways
    if (parts.length === 3 && parts[0] === "agents" && parts[2] === "gateways" && method === "POST") {
      const agentId = parts[1]!;
      const body = await readJsonBody(req);
      const reqCtx = parseRequestContext(body, agentId);
      const provider = requireString(body, "provider") as RuntimeGatewayProvider;
      if (!SUPPORTED_PROVIDERS.has(provider)) {
        throw new SetupError("bad_request", "unsupported provider");
      }
      const adapter = requireAdapter(opts.adapters, provider);
      const loginId = requireString(body, "loginId");
      const out = await adapter.finalize(
        {
          ...reqCtx,
          loginId,
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          config: (body.config as Record<string, unknown>) ?? {},
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        },
        ctx,
      );
      // Phase 3: if the new connection is enabled, kick the runner so
      // the provider adapter starts polling/listening immediately. The
      // adapter's `start(ctx)` is launched as a background task inside
      // `runner.startOne` — this call returns once the abort wiring is
      // installed, NOT after the first poll completes.
      const startOutcome = out.connection.enabled
        ? await tryStartConnection(opts, out.connection)
        : { ok: true as const, connection: out.connection };
      sendJson(res, 200, buildConnectionResponse(startOutcome));
      return;
    }

    // PATCH /agents/{agentId}/gateways/{gatewayId}
    if (parts.length === 4 && parts[0] === "agents" && parts[2] === "gateways" && method === "PATCH") {
      const agentId = parts[1]!;
      const gatewayId = parts[3]!;
      const body = await readJsonBody(req);
      const reqCtx = parseRequestContext(body, agentId);
      const conn = opts.store.getConnection(gatewayId);
      if (!conn || conn.agentId !== agentId) {
        throw new SetupError("not_found", "gateway not found");
      }
      const next: GatewayConnection = { ...conn, updatedAt: ctx.now() };
      if (typeof body.label === "string") next.label = body.label;
      if (typeof body.enabled === "boolean") next.enabled = body.enabled;
      if (body.config && typeof body.config === "object") {
        const cfg = body.config as Record<string, unknown>;
        const allowed: Record<string, unknown> = { ...next.config };
        for (const key of ["allowedSenderIds", "allowedChatIds", "splitAt", "domain"]) {
          if (key in cfg) allowed[key] = cfg[key];
        }
        next.config = allowed;
      }

      // Provider-specific secret rotation. Adapters that implement
      // `rotateSecret` (currently telegram) validate the new credential
      // upstream, run conflict guards, and mutate the secret store. Any
      // `configPatch` they return (e.g. updated tokenFingerprint) is merged
      // before we persist.
      if (body.secret && typeof body.secret === "object" && !Array.isArray(body.secret)) {
        const adapter = requireAdapter(opts.adapters, conn.provider);
        if (!adapter.rotateSecret) {
          throw new SetupError(
            "bad_request",
            "secret rotation not supported for this provider",
          );
        }
        const rotation = await adapter.rotateSecret(
          {
            ...reqCtx,
            gatewayId,
            secret: body.secret as Record<string, unknown>,
          },
          ctx,
        );
        if (rotation.configPatch) {
          const allowedRotationKeys = ["tokenFingerprint", "baseUrl"];
          const merged: Record<string, unknown> = { ...next.config };
          for (const key of allowedRotationKeys) {
            if (key in rotation.configPatch) merged[key] = rotation.configPatch[key];
          }
          next.config = merged;
        }
      }

      opts.store.upsertConnection(next);
      // Phase 3: align runner state with the updated `enabled` flag.
      //   prev.enabled && !next.enabled  → stop (idempotent)
      //   !prev.enabled && next.enabled  → start (may fail → warning)
      // A no-op change (enabled identical) is left alone.
      if (conn.enabled && !next.enabled) {
        await safeStopOne(opts, gatewayId);
        sendJson(res, 200, { ok: true, connection: redactConnection(next) });
        return;
      }
      if (!conn.enabled && next.enabled) {
        const outcome = await tryStartConnection(opts, next);
        sendJson(res, 200, buildConnectionResponse(outcome));
        return;
      }
      // Token rotation on an already-running connection: bounce the runner so
      // the provider polls/listens with the new credential. startOne is
      // idempotent — it stops the existing run first.
      if (next.enabled && opts.runner.isRunning(gatewayId) && body.secret) {
        const outcome = await tryStartConnection(opts, next);
        sendJson(res, 200, buildConnectionResponse(outcome));
        return;
      }
      sendJson(res, 200, { ok: true, connection: redactConnection(next) });
      return;
    }

    // DELETE /agents/{agentId}/gateways/{gatewayId}
    if (parts.length === 4 && parts[0] === "agents" && parts[2] === "gateways" && method === "DELETE") {
      const agentId = parts[1]!;
      const gatewayId = parts[3]!;
      const conn = opts.store.getConnection(gatewayId);
      if (!conn || conn.agentId !== agentId) {
        throw new SetupError("not_found", "gateway not found");
      }
      // Stop the adapter if running. `stopOne` is a no-op when not running.
      try {
        if (opts.runner.isRunning(gatewayId)) {
          await opts.runner.stopOne(gatewayId, "deleted");
        }
      } catch (err) {
        opts.log.warn("setup delete: runner.stopOne failed", {
          gatewayId,
          err: redact(String(err)),
        });
      }
      opts.store.deleteConnection(gatewayId);
      if (conn.secretRef) {
        try {
          opts.secrets.delete(conn.secretRef);
        } catch {
          // best-effort
        }
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /agents/{agentId}/gateways/{gatewayId}/test
    if (
      parts.length === 5 &&
      parts[0] === "agents" &&
      parts[2] === "gateways" &&
      parts[4] === "test" &&
      method === "POST"
    ) {
      const agentId = parts[1]!;
      const gatewayId = parts[3]!;
      const body = await readJsonBody(req);
      parseRequestContext(body, agentId);
      const conn = opts.store.getConnection(gatewayId);
      if (!conn || conn.agentId !== agentId) {
        throw new SetupError("not_found", "gateway not found");
      }
      const adapter = requireAdapter(opts.adapters, conn.provider);
      if (!adapter.test) {
        // MVP: surface stored status only when adapter has no live check.
        sendJson(res, 200, { ok: conn.status === "active", details: { status: conn.status } });
        return;
      }
      const reqCtx: SetupRequestContext = {
        userId: requireString(body, "user_id"),
        agentId,
        hostingKind: parseHostingKind(body),
        ...(typeof body.request_id === "string" ? { requestId: body.request_id } : {}),
      };
      const out = await adapter.test({ ...reqCtx, gatewayId }, ctx);
      sendJson(res, 200, { ...out, ok: out.ok });
      return;
    }

    throw new SetupError("not_found", "unknown path or method");
  } catch (err) {
    if (err instanceof SetupError) {
      sendError(res, err);
      return;
    }
    opts.log.error("setup server unexpected", { err: redact(String(err)) });
    sendError(res, new SetupError("internal", "internal server error"));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkAuth(req: IncomingMessage, expected: string): boolean {
  if (!expected) return false;
  const auth = headerValue(req, "authorization");
  const xSecret = headerValue(req, "x-ingress-secret");
  const supplied = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : xSecret;
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if ((req.headers["content-length"] ?? "") === "0") return {};
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new SetupError("bad_request", "request body too large");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new SetupError("bad_request", "request body must be a JSON object");
  } catch (err) {
    if (err instanceof SetupError) throw err;
    throw new SetupError("bad_request", "request body is not valid JSON");
  }
}

function parseRequestContext(body: Record<string, unknown>, agentId: string): SetupRequestContext {
  const userId = requireString(body, "user_id");
  return {
    userId,
    agentId,
    hostingKind: parseHostingKind(body),
    ...(typeof body.request_id === "string" ? { requestId: body.request_id } : {}),
  };
}

function parseHostingKind(body: Record<string, unknown>): "cloud" | "daemon" {
  const raw = body.hosting_kind;
  if (raw === "cloud" || raw === "daemon") return raw;
  throw new SetupError("bad_request", "hosting_kind must be 'cloud' or 'daemon'");
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new SetupError("bad_request", `${key} is required`);
  }
  return v;
}

function pick(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = body[key];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

/**
 * Build the `options` map handed to `loginStart` adapters. Fields under
 * a nested `options` object always win; provider-specific top-level
 * passthroughs (botToken, bot_token, baseUrl) are merged so the
 * dashboard can use the natural flat body shape.
 */
function mergeStartOptions(body: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of ["botToken", "bot_token", "baseUrl"]) {
    if (key in body) merged[key] = body[key];
  }
  const nested = pick(body, "options");
  if (nested) {
    for (const [k, v] of Object.entries(nested)) merged[k] = v;
  }
  return merged;
}

function requireAdapter(
  adapters: Record<string, ProviderSetupAdapter>,
  provider: string,
): ProviderSetupAdapter {
  const a = adapters[provider];
  if (!a) throw new SetupError("not_found", `provider ${provider} not registered`);
  return a;
}

function redactConnection(conn: GatewayConnection): Omit<GatewayConnection, "secretRef"> & {
  secretRef?: undefined;
} {
  // Drop secretRef from outbound shape; it's an internal pointer.
  const { secretRef: _drop, ...rest } = conn;
  return { ...rest, secretRef: undefined };
}

/**
 * Result of attempting to start a provider adapter for a freshly-persisted
 * (or newly-enabled) connection. On failure we keep the connection row
 * in the store but flip its `status` to `"error"` so the dashboard can
 * surface the issue; the user can PATCH `enabled=true` again to retry.
 */
type StartOutcome =
  | { ok: true; connection: GatewayConnection }
  | {
      ok: false;
      connection: GatewayConnection;
      warning: { code: "adapter_start_failed"; message: string };
    };

async function tryStartConnection(
  opts: SetupServerOptions,
  conn: GatewayConnection,
): Promise<StartOutcome> {
  try {
    const activeConn = await opts.runner.startOne(conn);
    return { ok: true, connection: activeConn };
  } catch (err) {
    const errStr = redact(String((err as Error)?.message ?? err));
    opts.log.error("runner.startOne failed", {
      gatewayId: conn.id,
      err: errStr,
    });
    const next: GatewayConnection = { ...conn, status: "error", updatedAt: opts.now ? opts.now() : Date.now() };
    try {
      opts.store.upsertConnection(next);
      opts.store.updateState(conn.id, { lastError: errStr });
    } catch {
      // best-effort — connection write was already done by finalize
    }
    return {
      ok: false,
      connection: next,
      warning: { code: "adapter_start_failed", message: errStr },
    };
  }
}

async function safeStopOne(opts: SetupServerOptions, gatewayId: string): Promise<void> {
  try {
    if (opts.runner.isRunning(gatewayId)) {
      await opts.runner.stopOne(gatewayId, "disabled");
    }
  } catch (err) {
    opts.log.warn("runner.stopOne failed", {
      gatewayId,
      err: redact(String(err)),
    });
  }
}

function buildConnectionResponse(outcome: StartOutcome): Record<string, unknown> {
  if (outcome.ok) {
    return { ok: true, connection: redactConnection(outcome.connection) };
  }
  return {
    ok: true,
    connection: redactConnection(outcome.connection),
    warning: outcome.warning,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function sendError(res: ServerResponse, err: SetupError): void {
  const body = { ok: false, error: { code: err.code as SetupErrorCode, message: redact(err.message) } };
  res.writeHead(err.status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const REDACT_PATTERNS = [
  // bearer / authorization headers in error strings
  /Bearer\s+[A-Za-z0-9._-]+/g,
  // generic long opaque tokens
  /[A-Za-z0-9_-]{32,}/g,
];

function redact(input: string): string {
  let out = input;
  for (const pat of REDACT_PATTERNS) {
    out = out.replace(pat, "[REDACTED]");
  }
  return out;
}
