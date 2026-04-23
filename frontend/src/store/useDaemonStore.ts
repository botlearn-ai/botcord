/**
 * [INPUT]: zustand for state, fetch for BFF requests at /api/daemon/*
 * [OUTPUT]: useDaemonStore — list / refresh / revoke for the current user's daemon instances
 * [POS]: dashboard daemon control-plane store
 * [PROTOCOL]: update header on changes
 */

import { create } from "zustand";

export interface DaemonRuntime {
  id: string;
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface DaemonInstance {
  id: string;
  label: string | null;
  status: "online" | "offline" | "revoked";
  created_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  runtimes?: DaemonRuntime[] | null;
  runtimes_probed_at?: string | null;
}

export interface ProvisionAgentInput {
  name?: string;
  bio?: string;
  runtime?: string;
  cwd?: string;
}

export interface ProvisionAgentResult {
  agentId: string;
}

export type ProvisionAgentErrorCode =
  | "daemon_offline"
  | "daemon_timeout"
  | "daemon_failed"
  | "missing_agent_id"
  | "http_error";

export class ProvisionAgentError extends Error {
  readonly code: ProvisionAgentErrorCode;
  readonly detail?: string;
  constructor(code: ProvisionAgentErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProvisionAgentError";
    this.code = code;
    this.detail = detail;
  }
}

interface DaemonState {
  daemons: DaemonInstance[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  revokingId: string | null;
  refreshingRuntimesId: string | null;
  runtimeErrors: Record<string, string>;

  refresh: () => Promise<void>;
  revoke: (id: string) => Promise<void>;
  refreshRuntimes: (id: string) => Promise<void>;
  provisionAgent: (
    daemonId: string,
    input: ProvisionAgentInput,
  ) => Promise<ProvisionAgentResult>;
  reset: () => void;
}

const initialState = {
  daemons: [] as DaemonInstance[],
  loading: false,
  loaded: false,
  error: null as string | null,
  revokingId: null as string | null,
  refreshingRuntimesId: null as string | null,
  runtimeErrors: {} as Record<string, string>,
};

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.error === "string") return data.error;
    if (typeof data?.message === "string") return data.message;
    if (typeof data?.detail === "string") return data.detail;
  } catch {
    // ignore
  }
  return res.statusText || `HTTP ${res.status}`;
}

function normalizeRuntimes(raw: unknown): DaemonRuntime[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const out: DaemonRuntime[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    out.push({
      id,
      available: r.available === true,
      version: typeof r.version === "string" ? r.version : undefined,
      path: typeof r.path === "string" ? r.path : undefined,
      error: typeof r.error === "string" ? r.error : undefined,
    });
  }
  return out;
}

function normalizeDaemon(raw: Record<string, unknown>): DaemonInstance {
  const revokedAt = (raw.revoked_at as string | null) ?? null;
  const explicitStatus = (raw.status as string | undefined) ?? null;
  const online = raw.online === true;
  let status: DaemonInstance["status"];
  if (revokedAt) {
    status = "revoked";
  } else if (
    explicitStatus === "online" ||
    explicitStatus === "offline" ||
    explicitStatus === "revoked"
  ) {
    status = explicitStatus;
  } else {
    status = online ? "online" : "offline";
  }
  return {
    id: String(raw.id ?? ""),
    label: (raw.label as string | null) ?? null,
    status,
    created_at: (raw.created_at as string | null) ?? null,
    last_seen_at: (raw.last_seen_at as string | null) ?? null,
    revoked_at: revokedAt,
    runtimes: normalizeRuntimes(raw.runtimes),
    runtimes_probed_at: (raw.runtimes_probed_at as string | null) ?? null,
  };
}

export const useDaemonStore = create<DaemonState>()((set, get) => ({
  ...initialState,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch("/api/daemon/instances", {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        const msg = await parseError(res);
        set({ loading: false, error: msg });
        return;
      }
      const data = await res.json().catch(() => null);
      const list = Array.isArray(data?.instances)
        ? data.instances
        : Array.isArray(data?.daemons)
          ? data.daemons
          : Array.isArray(data)
            ? data
            : [];
      set({
        daemons: (list as Record<string, unknown>[]).map(normalizeDaemon),
        loading: false,
        loaded: true,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load daemons",
      });
    }
  },

  revoke: async (id: string) => {
    set({ revokingId: id, error: null });
    try {
      const res = await fetch(
        `/api/daemon/instances/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      );
      if (!res.ok) {
        const msg = await parseError(res);
        set({ revokingId: null, error: msg });
        return;
      }
      // Optimistic local update; refresh will reconcile
      set({
        daemons: get().daemons.map((d) =>
          d.id === id
            ? { ...d, status: "revoked", revoked_at: new Date().toISOString() }
            : d,
        ),
        revokingId: null,
      });
      void get().refresh();
    } catch (err) {
      set({
        revokingId: null,
        error: err instanceof Error ? err.message : "Failed to revoke",
      });
    }
  },

  refreshRuntimes: async (id: string) => {
    set((state) => {
      const next = { ...state.runtimeErrors };
      delete next[id];
      return { refreshingRuntimesId: id, runtimeErrors: next };
    });
    try {
      const res = await fetch(
        `/api/daemon/instances/${encodeURIComponent(id)}/refresh-runtimes`,
        { method: "POST" },
      );
      if (!res.ok) {
        let msg: string;
        if (res.status === 409) {
          msg = "daemon offline, start it first";
        } else if (res.status === 502) {
          msg = "daemon didn't respond";
        } else {
          msg = await parseError(res);
        }
        set((state) => ({
          refreshingRuntimesId: null,
          runtimeErrors: { ...state.runtimeErrors, [id]: msg },
        }));
        return;
      }
      const data = await res.json().catch(() => null);
      const runtimes = normalizeRuntimes(data?.runtimes) ?? null;
      const probedAt =
        typeof data?.runtimes_probed_at === "string"
          ? data.runtimes_probed_at
          : new Date().toISOString();
      set({
        daemons: get().daemons.map((d) =>
          d.id === id
            ? { ...d, runtimes, runtimes_probed_at: probedAt }
            : d,
        ),
        refreshingRuntimesId: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to refresh runtimes";
      set((state) => ({
        refreshingRuntimesId: null,
        runtimeErrors: { ...state.runtimeErrors, [id]: msg },
      }));
    }
  },

  provisionAgent: async (daemonId, input) => {
    const params: Record<string, unknown> = {};
    if (input.name) params.name = input.name;
    if (input.bio) params.bio = input.bio;
    if (input.runtime) params.runtime = input.runtime;
    if (input.cwd) params.cwd = input.cwd;

    const res = await fetch(
      `/api/daemon/instances/${encodeURIComponent(daemonId)}/dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "provision_agent", params }),
      },
    );
    if (!res.ok) {
      if (res.status === 409) {
        throw new ProvisionAgentError("daemon_offline");
      }
      if (res.status === 504) {
        throw new ProvisionAgentError("daemon_timeout");
      }
      throw new ProvisionAgentError("http_error", await parseError(res));
    }
    const data = await res.json().catch(() => null);
    const ack = data?.ack as { ok?: boolean; result?: unknown; error?: { message?: string } } | undefined;
    if (!ack || ack.ok !== true) {
      const detail =
        typeof ack?.error?.message === "string" ? ack.error.message : undefined;
      throw new ProvisionAgentError("daemon_failed", detail);
    }
    const result = (ack.result ?? {}) as Record<string, unknown>;
    const agentId =
      typeof result.agentId === "string"
        ? result.agentId
        : typeof result.agent_id === "string"
          ? (result.agent_id as string)
          : null;
    if (!agentId) {
      throw new ProvisionAgentError("missing_agent_id");
    }
    return { agentId };
  },

  reset: () => set({ ...initialState }),
}));
