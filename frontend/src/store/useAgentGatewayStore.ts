/**
 * [INPUT]: zustand store; BFF /api/agents/[agentId]/gateways* routes
 * [OUTPUT]: useAgentGatewayStore — list/create/patch/enable/disable/remove/test
 *          third-party gateway connections, plus WeChat scan-to-login flow.
 * [POS]: dashboard state for the AgentSettingsDrawer "Channels" (接入) tab
 * [PROTOCOL]: update header on changes
 */

import { create } from "zustand";

export type GatewayProvider = "telegram" | "wechat";
export type GatewayStatus = "pending" | "active" | "error" | "disabled";

export interface AgentGatewayConnection {
  id: string;
  provider: GatewayProvider;
  label: string | null;
  status: GatewayStatus;
  enabled: boolean;
  config: Record<string, unknown>;
  last_error?: string | null;
}

export interface TelegramCreateInput {
  provider: "telegram";
  label?: string | null;
  enabled?: boolean;
  secret: { botToken: string };
  config: {
    label?: string;
    allowedChatIds?: string[];
    allowedSenderIds?: string[];
    splitAt?: number;
  };
}

export interface WechatCreateInput {
  provider: "wechat";
  label?: string | null;
  enabled?: boolean;
  loginId: string;
  config: {
    label?: string;
    allowedSenderIds?: string[];
    baseUrl?: string;
    splitAt?: number;
  };
}

export type GatewayCreateInput = TelegramCreateInput | WechatCreateInput;

export interface GatewayPatchInput {
  label?: string | null;
  enabled?: boolean;
  config?: {
    allowedChatIds?: string[];
    allowedSenderIds?: string[];
    baseUrl?: string;
    splitAt?: number;
    label?: string;
  };
  // Telegram-only — used for explicit token rotate.
  secret?: { botToken: string };
}

export interface WechatLoginStartResponse {
  loginId: string;
  qrcode: string;
  qrcodeUrl?: string | null;
  expiresAt: number;
}

export type WechatLoginStatus =
  | "pending"
  | "scanned"
  | "confirmed"
  | "expired"
  | "failed";

export interface WechatLoginStatusResponse {
  status: WechatLoginStatus;
  baseUrl?: string | null;
  tokenPreview?: string | null;
}

export interface WechatSenderDiscoveryItem {
  id: string;
  label?: string | null;
}

export interface WechatSenderDiscoveryResponse {
  senders: WechatSenderDiscoveryItem[];
}

export interface GatewayTestResult {
  ok: boolean;
  message?: string | null;
  detail?: unknown;
}

export class GatewayApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const KNOWN_STATUSES = new Set<WechatLoginStatus>([
  "pending",
  "scanned",
  "confirmed",
  "expired",
  "failed",
]);

export function normalizeWechatStatus(raw: unknown): WechatLoginStatus {
  if (typeof raw === "string" && KNOWN_STATUSES.has(raw as WechatLoginStatus)) {
    return raw as WechatLoginStatus;
  }
  return "pending";
}

async function readErr(res: Response): Promise<GatewayApiError> {
  const text = await res.text().catch(() => "");
  let detail: string | undefined;
  let code: string | undefined;
  try {
    const json = JSON.parse(text) as {
      detail?: unknown;
      message?: unknown;
      error?: unknown;
      code?: unknown;
    };
    if (typeof json.detail === "string") detail = json.detail;
    else if (typeof json.message === "string") detail = json.message;
    if (typeof json.error === "string") code = json.error;
    else if (typeof json.code === "string") code = json.code;
  } catch {
    // ignore
  }
  // Map status codes to friendly defaults.
  if (!detail) {
    if (res.status === 409) detail = "daemon offline";
    else if (res.status === 429) detail = "too many requests, please wait";
    else if (res.status === 400) detail = code === "provider_auth_failed"
      ? "provider auth failed"
      : "bad request";
    else if (res.status === 502) detail = "daemon gateway failed";
    else if (res.status === 504) detail = "操作已提交，daemon 响应较慢，请稍后刷新确认。";
    else detail = `HTTP ${res.status}`;
  }
  return new GatewayApiError(detail, res.status, code);
}

interface AgentGatewayState {
  byAgent: Record<string, AgentGatewayConnection[]>;
  loading: Record<string, boolean>;
  daemonOffline: Record<string, boolean>;
  lastError: Record<string, string | null>;

  load: (agentId: string) => Promise<AgentGatewayConnection[]>;
  create: (
    agentId: string,
    input: GatewayCreateInput,
  ) => Promise<AgentGatewayConnection>;
  patch: (
    agentId: string,
    gatewayId: string,
    patch: GatewayPatchInput,
  ) => Promise<AgentGatewayConnection>;
  enable: (agentId: string, gatewayId: string) => Promise<AgentGatewayConnection>;
  disable: (agentId: string, gatewayId: string) => Promise<AgentGatewayConnection>;
  remove: (agentId: string, gatewayId: string, opts?: { force?: boolean }) => Promise<void>;
  test: (agentId: string, gatewayId: string) => Promise<GatewayTestResult>;
  startWechatLogin: (
    agentId: string,
    opts?: { baseUrl?: string },
  ) => Promise<WechatLoginStartResponse>;
  pollWechatLogin: (
    agentId: string,
    loginId: string,
  ) => Promise<WechatLoginStatusResponse>;
  discoverWechatSenders: (
    agentId: string,
    loginId: string,
    opts?: { timeoutSeconds?: number },
  ) => Promise<WechatSenderDiscoveryResponse>;
}

function base(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/gateways`;
}

function parseGatewayList(json: unknown): AgentGatewayConnection[] {
  if (Array.isArray(json)) return json as AgentGatewayConnection[];
  if (!json || typeof json !== "object") return [];

  const record = json as {
    gateways?: unknown;
    items?: unknown;
  };
  if (Array.isArray(record.gateways)) {
    return record.gateways as AgentGatewayConnection[];
  }
  if (Array.isArray(record.items)) {
    return record.items as AgentGatewayConnection[];
  }
  return [];
}

export const useAgentGatewayStore = create<AgentGatewayState>((set, get) => ({
  byAgent: {},
  loading: {},
  daemonOffline: {},
  lastError: {},

  async load(agentId) {
    set((s) => ({ loading: { ...s.loading, [agentId]: true } }));
    try {
      const res = await fetch(base(agentId), { cache: "no-store" });
      if (!res.ok) throw await readErr(res);
      const list = parseGatewayList(await res.json());
      set((s) => ({
        byAgent: { ...s.byAgent, [agentId]: list },
        daemonOffline: { ...s.daemonOffline, [agentId]: false },
        lastError: { ...s.lastError, [agentId]: null },
      }));
      return list;
    } catch (err) {
      const apiErr = err as GatewayApiError;
      set((s) => ({
        daemonOffline: {
          ...s.daemonOffline,
          [agentId]: apiErr?.status === 409,
        },
        lastError: {
          ...s.lastError,
          [agentId]: apiErr?.message ?? String(err),
        },
      }));
      throw err;
    } finally {
      set((s) => {
        const next = { ...s.loading };
        delete next[agentId];
        return { loading: next };
      });
    }
  },

  async create(agentId, input) {
    const res = await fetch(base(agentId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await readErr(res);
      if (err.status === 409) {
        set((s) => ({ daemonOffline: { ...s.daemonOffline, [agentId]: true } }));
      }
      throw err;
    }
    const created = (await res.json()) as AgentGatewayConnection;
    set((s) => {
      const cur = s.byAgent[agentId] ?? [];
      return {
        byAgent: { ...s.byAgent, [agentId]: [...cur, created] },
        daemonOffline: { ...s.daemonOffline, [agentId]: false },
      };
    });
    return created;
  },

  async patch(agentId, gatewayId, patch) {
    const res = await fetch(`${base(agentId)}/${encodeURIComponent(gatewayId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const err = await readErr(res);
      if (err.status === 409) {
        set((s) => ({ daemonOffline: { ...s.daemonOffline, [agentId]: true } }));
      }
      throw err;
    }
    const updated = (await res.json()) as AgentGatewayConnection;
    set((s) => {
      const cur = s.byAgent[agentId] ?? [];
      return {
        byAgent: {
          ...s.byAgent,
          [agentId]: cur.map((g) => (g.id === gatewayId ? updated : g)),
        },
      };
    });
    return updated;
  },

  async enable(agentId, gatewayId) {
    return get().patch(agentId, gatewayId, { enabled: true });
  },

  async disable(agentId, gatewayId) {
    return get().patch(agentId, gatewayId, { enabled: false });
  },

  async remove(agentId, gatewayId, opts) {
    const qs = opts?.force ? "?force=1" : "";
    const res = await fetch(`${base(agentId)}/${encodeURIComponent(gatewayId)}${qs}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 204) {
      const err = await readErr(res);
      if (err.status === 409) {
        set((s) => ({ daemonOffline: { ...s.daemonOffline, [agentId]: true } }));
      }
      throw err;
    }
    set((s) => {
      const cur = s.byAgent[agentId] ?? [];
      return {
        byAgent: {
          ...s.byAgent,
          [agentId]: cur.filter((g) => g.id !== gatewayId),
        },
      };
    });
  },

  async test(agentId, gatewayId) {
    const res = await fetch(
      `${base(agentId)}/${encodeURIComponent(gatewayId)}/test`,
      { method: "POST" },
    );
    if (!res.ok) {
      const err = await readErr(res);
      if (err.status === 409 || err.status === 502 || err.status === 504) {
        set((s) => ({ daemonOffline: { ...s.daemonOffline, [agentId]: true } }));
      }
      // Surface as a value, not a throw — UI shows error inline per row.
      return { ok: false, message: err.message };
    }
    // W5: the BFF wraps the daemon ack as `{ok: true, result: {...}}`. A
    // daemon-side test failure surfaces as `result.ok === false` with an
    // `error` string, NOT as an outer 200/`ok: false`. Unwrap explicitly so
    // the UI doesn't render a green check on a failed probe.
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { ok?: boolean; error?: string; info?: unknown };
      message?: string;
    } & GatewayTestResult;
    const inner = json?.result;
    if (inner && typeof inner === "object" && inner.ok === false) {
      return {
        ok: false,
        message: typeof inner.error === "string" ? inner.error : "test failed",
        detail: inner,
      };
    }
    if (inner && typeof inner === "object") {
      return { ok: inner.ok !== false, detail: inner };
    }
    return { ...json, ok: json?.ok !== false };
  },

  async startWechatLogin(agentId, opts) {
    const res = await fetch(`${base(agentId)}/wechat/login/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts ?? {}),
    });
    if (!res.ok) {
      const err = await readErr(res);
      if (err.status === 409) {
        set((s) => ({ daemonOffline: { ...s.daemonOffline, [agentId]: true } }));
      }
      throw err;
    }
    return (await res.json()) as WechatLoginStartResponse;
  },

  async pollWechatLogin(agentId, loginId) {
    const res = await fetch(`${base(agentId)}/wechat/login/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId }),
    });
    if (!res.ok) {
      const err = await readErr(res);
      if (err.status === 409) {
        set((s) => ({ daemonOffline: { ...s.daemonOffline, [agentId]: true } }));
      }
      throw err;
    }
    const json = (await res.json()) as Partial<WechatLoginStatusResponse>;
    return {
      status: normalizeWechatStatus(json.status),
      baseUrl: json.baseUrl ?? null,
      tokenPreview: json.tokenPreview ?? null,
    };
  },

  async discoverWechatSenders(agentId, loginId, opts) {
    const res = await fetch(`${base(agentId)}/wechat/senders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginId,
        timeoutSeconds: opts?.timeoutSeconds ?? 0,
      }),
    });
    if (!res.ok) {
      const err = await readErr(res);
      if (err.status === 409) {
        set((s) => ({ daemonOffline: { ...s.daemonOffline, [agentId]: true } }));
      }
      throw err;
    }
    const json = (await res.json()) as { senders?: unknown[] };
    const senders: WechatSenderDiscoveryItem[] = [];
    if (Array.isArray(json.senders)) {
      for (const item of json.senders) {
        if (typeof item === "string") {
          senders.push({ id: item, label: null });
          continue;
        }
        if (!item || typeof item !== "object") continue;
        const raw = item as Record<string, unknown>;
        const id =
          typeof raw.id === "string"
            ? raw.id
            : typeof raw.userId === "string"
              ? raw.userId
              : typeof raw.senderId === "string"
                ? raw.senderId
                : "";
        if (!id) continue;
        const label =
          typeof raw.label === "string"
            ? raw.label
            : typeof raw.name === "string"
              ? raw.name
              : typeof raw.remark === "string"
                ? raw.remark
                : null;
        senders.push({ id, label });
      }
    }
    return { senders };
  },
}));
