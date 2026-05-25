import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { IngressLogger } from "./log.js";
import type { ProviderRunner } from "./provider-runner.js";
import type { IngressSecretStore } from "./storage/secrets.js";
import type { IngressStore } from "./storage/store.js";
import type { GatewayConnection, GatewayStatus } from "./types.js";

export interface AdminSyncServerOptions {
  host: string;
  port: number;
  ingressSecret: string;
  log: IngressLogger;
  store: IngressStore;
  secrets: IngressSecretStore;
  runner: ProviderRunner;
}

export interface AdminSyncServer {
  url: string;
  close(): Promise<void>;
}

type Provider = GatewayConnection["provider"];

interface GatewaySyncBody {
  id?: unknown;
  agentId?: unknown;
  userId?: unknown;
  provider?: unknown;
  label?: unknown;
  status?: unknown;
  enabled?: unknown;
  config?: unknown;
  secret?: unknown;
  secretRef?: unknown;
}

const PROVIDERS = new Set<Provider>(["telegram", "wechat", "feishu"]);
const STATUSES = new Set<GatewayStatus>(["active", "disabled", "pending", "error"]);
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function gatewayIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const parsed = new URL(url, "http://ingress.local");
  const m = /^\/admin\/gateways\/([^/]+)$/.exec(parsed.pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

function requireAuth(req: IncomingMessage, ingressSecret: string): boolean {
  if (!ingressSecret) return false;
  const header = req.headers.authorization;
  return header === `Bearer ${ingressSecret}`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function normalizeBody(gatewayId: string, body: GatewaySyncBody): GatewayConnection {
  if (body.id !== undefined && body.id !== gatewayId) {
    throw new Error("gateway_id_mismatch");
  }
  const agentId = stringOrUndefined(body.agentId);
  if (!agentId) throw new Error("missing_agent_id");
  if (!PROVIDERS.has(body.provider as Provider)) throw new Error("unsupported_provider");

  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  const status =
    STATUSES.has(body.status as GatewayStatus)
      ? (body.status as GatewayStatus)
      : enabled
        ? "active"
        : "disabled";
  const config =
    body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : {};
  const now = Date.now();

  return {
    id: gatewayId,
    agentId,
    ...(stringOrUndefined(body.userId) ? { userId: stringOrUndefined(body.userId) } : {}),
    provider: body.provider as Provider,
    ...(stringOrUndefined(body.label) ? { label: stringOrUndefined(body.label) } : {}),
    status,
    enabled,
    config,
    ...(stringOrUndefined(body.secretRef) ? { secretRef: stringOrUndefined(body.secretRef) } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function mergeConnection(
  gatewayId: string,
  current: GatewayConnection | null,
  body: GatewaySyncBody,
): GatewayConnection {
  const incoming = normalizeBody(gatewayId, body);
  return {
    ...incoming,
    createdAt: current?.createdAt ?? incoming.createdAt,
    updatedAt: Date.now(),
    secretRef: incoming.secretRef ?? current?.secretRef ?? gatewayId,
  };
}

async function handleUpsert(
  opts: AdminSyncServerOptions,
  gatewayId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const parsed = await readBody(req);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJson(res, 400, { ok: false, error: "invalid_body" });
    return;
  }
  const body = parsed as GatewaySyncBody;
  const current = opts.store.getConnection(gatewayId);
  const next = mergeConnection(gatewayId, current, body);

  if (body.secret !== undefined) {
    if (body.secret === null) {
      opts.secrets.delete(next.secretRef ?? gatewayId);
      next.secretRef = undefined;
    } else if (typeof body.secret === "object" && !Array.isArray(body.secret)) {
      opts.secrets.write(next.secretRef ?? gatewayId, body.secret);
    } else {
      sendJson(res, 400, { ok: false, error: "invalid_secret" });
      return;
    }
  } else if (!next.secretRef && current?.secretRef) {
    next.secretRef = current.secretRef;
  }

  opts.store.upsertConnection(next);
  const hasSecret = Boolean(next.secretRef && opts.secrets.load(next.secretRef));
  if (next.enabled && hasSecret) {
    await opts.runner.startOne(next);
  } else if (next.enabled) {
    await opts.runner.stopOne(gatewayId, "admin-sync-missing-secret");
  } else {
    await opts.runner.stopOne(gatewayId, "admin-sync-disabled");
  }
  opts.log.info("gateway sync upserted", {
    gatewayId,
    provider: next.provider,
    agentId: next.agentId,
    enabled: next.enabled,
  });
  sendJson(res, 200, {
    ok: true,
    gateway: {
      id: next.id,
      agentId: next.agentId,
      provider: next.provider,
      status: next.status,
      enabled: next.enabled,
      hasSecret,
    },
  });
}

async function handleDelete(
  opts: AdminSyncServerOptions,
  gatewayId: string,
  res: ServerResponse,
): Promise<void> {
  const current = opts.store.getConnection(gatewayId);
  await opts.runner.stopOne(gatewayId, "admin-sync-delete");
  if (current?.secretRef) opts.secrets.delete(current.secretRef);
  opts.store.deleteConnection(gatewayId);
  opts.log.info("gateway sync deleted", { gatewayId });
  sendJson(res, 200, { ok: true, deleted: true });
}

export async function startAdminSyncServer(
  opts: AdminSyncServerOptions,
): Promise<AdminSyncServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (!requireAuth(req, opts.ingressSecret)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const gatewayId = gatewayIdFromUrl(req.url);
      if (!gatewayId) {
        sendJson(res, 404, { ok: false, error: "not_found" });
        return;
      }
      try {
        if (req.method === "PUT") {
          await handleUpsert(opts, gatewayId, req, res);
          return;
        }
        if (req.method === "DELETE") {
          await handleDelete(opts, gatewayId, res);
          return;
        }
        sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "sync_failed";
        const status = message === "body_too_large" ? 413 : 400;
        opts.log.warn("gateway sync request failed", { gatewayId, err: message });
        sendJson(res, status, { ok: false, error: message });
      }
    })();
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

  opts.log.info("ingress admin sync server", { url });
  return {
    url,
    async close(): Promise<void> {
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
