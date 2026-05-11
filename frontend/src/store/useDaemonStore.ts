/**
 * [INPUT]: zustand for state, fetch for BFF requests at /api/daemon/*
 * [OUTPUT]: useDaemonStore — list / refresh / revoke for the current user's daemon instances
 * [POS]: dashboard daemon control-plane store
 * [PROTOCOL]: update header on changes
 *
 * Identity notes:
 *   Daemon instances are scoped to the authenticated user, NOT the active
 *   agent, so list/refresh/revoke/refreshRuntimes all work regardless of
 *   whether the active identity is Human or Agent. Any future agent-scoped
 *   daemon action (e.g., dispatch to a specific agent) MUST first check
 *   `useDashboardSessionStore.getState().activeIdentity` and no-op with a
 *   "No agent selected" error when the identity is Human — see
 *   `requireActiveAgentId` below.
 */

import { create } from "zustand";
import { useDashboardSessionStore } from "./useDashboardSessionStore";

export interface DaemonRuntimeEndpoint {
  name: string;
  url: string;
  reachable: boolean;
  status?: "reachable" | "unreachable" | "acp_disabled";
  version?: string;
  error?: string;
  diagnostics?: Array<{ code: string; message?: string }>;
  agents?: Array<{
    id: string;
    name?: string;
    workspace?: string;
    model?: { name?: string; provider?: string };
    botcordBinding?: {
      agentId: string;
    };
  }>;
}

export interface DaemonHermesProfile {
  name: string;
  home: string;
  isDefault?: boolean;
  isActive?: boolean;
  /** BotCord agent currently bound to this profile, if any. */
  occupiedBy?: string;
  occupiedByName?: string;
  modelName?: string;
  sessionsCount?: number;
  hasSoul?: boolean;
}

export interface DaemonRuntime {
  id: string;
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
  /** OpenClaw-style runtimes carry per-gateway endpoint probe results. */
  endpoints?: DaemonRuntimeEndpoint[];
  /** Hermes runtime carries the per-device profile listing (1 BotCord agent : 1 profile). */
  profiles?: DaemonHermesProfile[];
}

export interface DaemonInstance {
  id: string;
  label: string | null;
  status: "online" | "offline" | "revoked" | "removal_pending";
  created_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  removal_requested_at: string | null;
  cleanup_completed_at: string | null;
  runtimes?: DaemonRuntime[] | null;
  runtimes_probed_at?: string | null;
}

export interface RemoveDeviceResult {
  ok: boolean;
  status: "removal_pending" | "revoked";
  was_online: boolean;
  detached_agents: Array<{ agent_id: string; display_name: string | null }>;
  cleanup_jobs_queued: number;
}

export interface DiagnosticBundleResult {
  bundle_id: string;
  filename: string;
  size_bytes: number;
  expires_at?: string | null;
  local_path?: string | null;
}

export interface ProvisionAgentInput {
  name: string;
  bio?: string;
  runtime?: string;
  cwd?: string;
  /** OpenClaw gateway profile name (only when runtime === "openclaw-acp"). */
  openclawGateway?: string;
  /** OpenClaw agent profile override. */
  openclawAgent?: string;
  /** Hermes profile name to attach to (only when runtime === "hermes-agent"). */
  hermesProfile?: string;
}

export interface ProvisionAgentResult {
  agentId: string;
}

export type ProvisionAgentErrorCode =
  | "daemon_offline"
  | "daemon_timeout"
  | "daemon_failed"
  | "missing_name"
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
  removingId: string | null;
  renamingId: string | null;
  refreshingRuntimesId: string | null;
  collectingDiagnosticsId: string | null;
  runtimeErrors: Record<string, string>;
  diagnosticErrors: Record<string, string>;
  diagnosticResults: Record<string, DiagnosticBundleResult>;
  renameErrors: Record<string, string>;

  refresh: (opts?: { quiet?: boolean }) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  removeDevice: (
    id: string,
    opts?: { forgetIfOffline?: boolean; reason?: string },
  ) => Promise<RemoveDeviceResult>;
  rename: (id: string, label: string | null) => Promise<boolean>;
  refreshRuntimes: (id: string, opts?: { quiet?: boolean }) => Promise<void>;
  collectDiagnostics: (id: string) => Promise<DiagnosticBundleResult | null>;
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
  removingId: null as string | null,
  renamingId: null as string | null,
  refreshingRuntimesId: null as string | null,
  collectingDiagnosticsId: null as string | null,
  runtimeErrors: {} as Record<string, string>,
  diagnosticErrors: {} as Record<string, string>,
  diagnosticResults: {} as Record<string, DiagnosticBundleResult>,
  renameErrors: {} as Record<string, string>,
};

/**
 * Returns the active agent id only when the session identity is "agent".
 * If the user is acting as themselves (Human) or no agent is selected,
 * returns null — agent-scoped daemon callers should treat this as a no-op
 * and surface a "No agent selected" toast/error rather than crashing.
 */
export function requireActiveAgentId(): string | null {
  const { activeIdentity, activeAgentId } = useDashboardSessionStore.getState();
  if (activeIdentity?.type === "agent") return activeIdentity.id;
  // Legacy fallback: no identity set yet but an agent id exists.
  if (!activeIdentity && activeAgentId) return activeAgentId;
  return null;
}

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
    const endpoints = Array.isArray(r.endpoints)
      ? (r.endpoints as unknown[])
          .map((rawEp) => {
            if (!rawEp || typeof rawEp !== "object") return null;
            const ep = rawEp as Record<string, unknown>;
            const epName = typeof ep.name === "string" ? ep.name : null;
            const epUrl = typeof ep.url === "string" ? ep.url : null;
            if (!epName || !epUrl) return null;
            return {
              name: epName,
              url: epUrl,
              reachable: ep.reachable === true,
              status:
                ep.status === "reachable" ||
                ep.status === "unreachable" ||
                ep.status === "acp_disabled"
                  ? ep.status
                  : undefined,
              version: typeof ep.version === "string" ? ep.version : undefined,
              error: typeof ep.error === "string" ? ep.error : undefined,
              diagnostics: Array.isArray(ep.diagnostics)
                ? (ep.diagnostics as unknown[])
                    .map((d) => {
                      if (!d || typeof d !== "object") return null;
                      const dx = d as Record<string, unknown>;
                      const code = typeof dx.code === "string" ? dx.code : null;
                      if (!code) return null;
                      return {
                        code,
                        message:
                          typeof dx.message === "string" ? dx.message : undefined,
                      };
                    })
                    .filter(Boolean) as DaemonRuntimeEndpoint["diagnostics"]
                : undefined,
              agents: Array.isArray(ep.agents)
                ? ((ep.agents as unknown[])
                    .map((a) => {
                      if (!a || typeof a !== "object") return null;
                      const ax = a as Record<string, unknown>;
                      const id = typeof ax.id === "string" ? ax.id : null;
                      if (!id) return null;
                      const model =
                        ax.model && typeof ax.model === "object"
                          ? {
                              name:
                                typeof (ax.model as any).name === "string"
                                  ? (ax.model as any).name
                                  : undefined,
                              provider:
                                typeof (ax.model as any).provider === "string"
                                  ? (ax.model as any).provider
                                  : undefined,
                            }
                          : undefined;
                      return {
                        id,
                        name: typeof ax.name === "string" ? ax.name : undefined,
                        workspace:
                          typeof ax.workspace === "string" ? ax.workspace : undefined,
                        model,
                        botcordBinding:
                          ax.botcordBinding &&
                          typeof ax.botcordBinding === "object" &&
                          typeof (ax.botcordBinding as any).agentId === "string"
                            ? { agentId: (ax.botcordBinding as any).agentId }
                            : undefined,
                      };
                    })
                    .filter(Boolean) as DaemonRuntimeEndpoint["agents"])
                : undefined,
            } as DaemonRuntimeEndpoint;
          })
          .filter(Boolean) as DaemonRuntimeEndpoint[]
      : undefined;
    const profiles = Array.isArray(r.profiles)
      ? ((r.profiles as unknown[])
          .map((rawP) => {
            if (!rawP || typeof rawP !== "object") return null;
            const p = rawP as Record<string, unknown>;
            const name = typeof p.name === "string" ? p.name : null;
            const home = typeof p.home === "string" ? p.home : null;
            if (!name || !home) return null;
            return {
              name,
              home,
              isDefault: p.isDefault === true,
              isActive: p.isActive === true,
              occupiedBy:
                typeof p.occupiedBy === "string" ? p.occupiedBy : undefined,
              occupiedByName:
                typeof p.occupiedByName === "string"
                  ? p.occupiedByName
                  : undefined,
              modelName:
                typeof p.modelName === "string" ? p.modelName : undefined,
              sessionsCount:
                typeof p.sessionsCount === "number" ? p.sessionsCount : undefined,
              hasSoul: p.hasSoul === true,
            } as DaemonHermesProfile;
          })
          .filter(Boolean) as DaemonHermesProfile[])
      : undefined;
    out.push({
      id,
      available: r.available === true,
      version: typeof r.version === "string" ? r.version : undefined,
      path: typeof r.path === "string" ? r.path : undefined,
      error: typeof r.error === "string" ? r.error : undefined,
      endpoints,
      profiles,
    });
  }
  return out;
}

function normalizeDaemon(raw: Record<string, unknown>): DaemonInstance {
  const revokedAt = (raw.revoked_at as string | null) ?? null;
  const removalRequestedAt = (raw.removal_requested_at as string | null) ?? null;
  const cleanupCompletedAt = (raw.cleanup_completed_at as string | null) ?? null;
  const explicitStatus = (raw.status as string | undefined) ?? null;
  const online = raw.online === true;
  let status: DaemonInstance["status"];
  if (revokedAt || explicitStatus === "revoked") {
    status = "revoked";
  } else if (removalRequestedAt || explicitStatus === "removal_pending") {
    status = "removal_pending";
  } else if (explicitStatus === "online" || explicitStatus === "offline") {
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
    removal_requested_at: removalRequestedAt,
    cleanup_completed_at: cleanupCompletedAt,
    runtimes: normalizeRuntimes(raw.runtimes),
    runtimes_probed_at: (raw.runtimes_probed_at as string | null) ?? null,
  };
}

function markRuntimeSelectionBound(
  daemons: DaemonInstance[],
  daemonId: string,
  input: ProvisionAgentInput,
  agentId: string,
): DaemonInstance[] {
  if (input.runtime !== "openclaw-acp" && input.runtime !== "hermes-agent") {
    return daemons;
  }

  return daemons.map((daemon) => {
    if (daemon.id !== daemonId || !daemon.runtimes) return daemon;
    let changed = false;
    const runtimes = daemon.runtimes.map((runtime) => {
      if (runtime.id !== input.runtime) return runtime;

      if (
        input.runtime === "openclaw-acp" &&
        input.openclawGateway &&
        input.openclawAgent &&
        runtime.endpoints
      ) {
        const endpoints = runtime.endpoints.map((endpoint) => {
          if (endpoint.name !== input.openclawGateway || !endpoint.agents) {
            return endpoint;
          }
          const agents = endpoint.agents.map((profile) => {
            if (profile.id !== input.openclawAgent) return profile;
            changed = true;
            return { ...profile, botcordBinding: { agentId } };
          });
          return { ...endpoint, agents };
        });
        return { ...runtime, endpoints };
      }

      if (input.runtime === "hermes-agent" && input.hermesProfile && runtime.profiles) {
        const profiles = runtime.profiles.map((profile) => {
          if (profile.name !== input.hermesProfile) return profile;
          changed = true;
          return {
            ...profile,
            occupiedBy: agentId,
            occupiedByName: input.name.trim() || agentId,
          };
        });
        return { ...runtime, profiles };
      }

      return runtime;
    });
    return changed ? { ...daemon, runtimes } : daemon;
  });
}

export const useDaemonStore = create<DaemonState>()((set, get) => ({
  ...initialState,

  refresh: async (opts) => {
    const quiet = opts?.quiet === true;
    if (!quiet) set({ loading: true, error: null });
    try {
      const res = await fetch("/api/daemon/instances", {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        if (quiet) return;
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
      const daemons = (list as Record<string, unknown>[])
        .map(normalizeDaemon)
        .filter((d) => !d.revoked_at);
      set(
        quiet
          ? { daemons, loaded: true }
          : { daemons, loading: false, loaded: true, error: null },
      );
    } catch (err) {
      if (quiet) return;
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
      // Optimistic local update; refresh will reconcile. Revoked daemon
      // instances are hidden from the frontend list.
      set({
        daemons: get().daemons.filter((d) => d.id !== id),
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

  removeDevice: async (id, opts) => {
    set({ removingId: id, error: null });
    try {
      const res = await fetch(
        `/api/daemon/instances/${encodeURIComponent(id)}/remove`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            forget_if_offline: opts?.forgetIfOffline === true,
            ...(opts?.reason ? { reason: opts.reason } : {}),
          }),
        },
      );
      if (!res.ok) {
        const msg = await parseError(res);
        set({ removingId: null, error: msg });
        throw new Error(msg);
      }
      const data = (await res.json().catch(() => null)) as
        | RemoveDeviceResult
        | null;
      // Optimistic local update: drop the device when fully revoked,
      // mark it removal_pending otherwise. `refresh` reconciles after.
      const finalStatus = data?.status ?? "removal_pending";
      set({
        daemons:
          finalStatus === "revoked"
            ? get().daemons.filter((d) => d.id !== id)
            : get().daemons.map((d) =>
                d.id === id ? { ...d, status: "removal_pending" } : d,
              ),
        removingId: null,
      });
      void get().refresh({ quiet: true });
      return (
        data ?? {
          ok: true,
          status: "removal_pending",
          was_online: false,
          detached_agents: [],
          cleanup_jobs_queued: 0,
        }
      );
    } catch (err) {
      if (!(err instanceof Error)) {
        set({ removingId: null });
        throw new Error("Failed to remove device");
      }
      set((state) => ({
        removingId: null,
        error: state.error ?? err.message,
      }));
      throw err;
    }
  },

  rename: async (id: string, label: string | null) => {
    const trimmed = label?.trim() || null;
    if (trimmed && trimmed.length > 64) {
      set((state) => ({
        renameErrors: { ...state.renameErrors, [id]: "Label must be 64 chars or fewer" },
      }));
      return false;
    }
    set((state) => {
      const next = { ...state.renameErrors };
      delete next[id];
      return { renamingId: id, renameErrors: next };
    });
    try {
      const res = await fetch(`/api/daemon/instances/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: trimmed }),
      });
      if (!res.ok) {
        const msg = await parseError(res);
        set((state) => ({
          renamingId: null,
          renameErrors: { ...state.renameErrors, [id]: msg },
        }));
        return false;
      }
      const data = (await res.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      const newLabel =
        data && typeof data.label === "string"
          ? (data.label as string)
          : trimmed;
      set({
        daemons: get().daemons.map((d) =>
          d.id === id ? { ...d, label: newLabel } : d,
        ),
        renamingId: null,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to rename";
      set((state) => ({
        renamingId: null,
        renameErrors: { ...state.renameErrors, [id]: msg },
      }));
      return false;
    }
  },

  refreshRuntimes: async (id, opts) => {
    const quiet = opts?.quiet === true;
    if (!quiet) {
      set((state) => {
        const next = { ...state.runtimeErrors };
        delete next[id];
        return { refreshingRuntimesId: id, runtimeErrors: next };
      });
    }
    try {
      const res = await fetch(
        `/api/daemon/instances/${encodeURIComponent(id)}/refresh-runtimes`,
        { method: "POST" },
      );
      if (!res.ok) {
        if (quiet) return;
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
        ...(quiet ? {} : { refreshingRuntimesId: null }),
      });
    } catch (err) {
      if (quiet) return;
      const msg = err instanceof Error ? err.message : "Failed to refresh runtimes";
      set((state) => ({
        refreshingRuntimesId: null,
        runtimeErrors: { ...state.runtimeErrors, [id]: msg },
      }));
    }
  },

  collectDiagnostics: async (id) => {
    set((state) => {
      const nextErrors = { ...state.diagnosticErrors };
      delete nextErrors[id];
      return { collectingDiagnosticsId: id, diagnosticErrors: nextErrors };
    });
    try {
      const res = await fetch(
        `/api/daemon/instances/${encodeURIComponent(id)}/diagnostics`,
        { method: "POST" },
      );
      if (!res.ok) {
        let msg: string;
        if (res.status === 409) {
          msg = "daemon offline, start it first";
        } else if (res.status === 504) {
          msg = "daemon timed out while collecting diagnostics";
        } else if (res.status === 502) {
          msg = "daemon failed to collect diagnostics";
        } else {
          msg = await parseError(res);
        }
        set((state) => ({
          collectingDiagnosticsId: null,
          diagnosticErrors: { ...state.diagnosticErrors, [id]: msg },
        }));
        return null;
      }
      const data = (await res.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      const result: DiagnosticBundleResult = {
        bundle_id: String(data?.bundle_id ?? ""),
        filename: String(data?.filename ?? "diagnostics.zip"),
        size_bytes:
          typeof data?.size_bytes === "number" ? data.size_bytes : 0,
        expires_at:
          typeof data?.expires_at === "string" ? data.expires_at : null,
        local_path:
          typeof data?.local_path === "string" ? data.local_path : null,
      };
      if (!result.bundle_id) {
        throw new Error("diagnostics response missing bundle id");
      }
      set((state) => ({
        collectingDiagnosticsId: null,
        diagnosticResults: { ...state.diagnosticResults, [id]: result },
      }));
      return result;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to collect diagnostics";
      set((state) => ({
        collectingDiagnosticsId: null,
        diagnosticErrors: { ...state.diagnosticErrors, [id]: msg },
      }));
      return null;
    }
  },

  provisionAgent: async (daemonId, input) => {
    // Hub owns keypair generation + DB insert; the backend ships the
    // credential envelope to the daemon via the provision_agent control
    // frame. The raw /dispatch path cannot be used here because it
    // bypasses the Agent/SigningKey insert and leaves the new identity
    // unclaimed in the registry.
    const label = input.name.trim();
    if (!label) {
      throw new ProvisionAgentError("missing_name");
    }
    const body: Record<string, unknown> = {
      daemon_instance_id: daemonId,
      label,
    };
    if (input.runtime) body.runtime = input.runtime;
    if (input.cwd) body.cwd = input.cwd;
    if (input.bio) body.bio = input.bio;
    if (input.openclawGateway) body.openclaw_gateway = input.openclawGateway;
    if (input.openclawAgent) body.openclaw_agent = input.openclawAgent;
    if (input.hermesProfile) body.hermes_profile = input.hermesProfile;

    const res = await fetch("/api/users/me/agents/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await parseError(res);
      if (res.status === 409) {
        if (detail === "daemon_offline") {
          throw new ProvisionAgentError("daemon_offline");
        }
        throw new ProvisionAgentError("http_error", detail);
      }
      if (res.status === 504) {
        throw new ProvisionAgentError("daemon_timeout");
      }
      if (res.status === 502) {
        throw new ProvisionAgentError("daemon_failed", detail);
      }
      throw new ProvisionAgentError("http_error", detail);
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const agentId =
      typeof data?.agent_id === "string"
        ? (data.agent_id as string)
        : typeof data?.agentId === "string"
          ? (data.agentId as string)
          : null;
    if (!agentId) {
      throw new ProvisionAgentError("missing_agent_id");
    }
    set((state) => ({
      daemons: markRuntimeSelectionBound(state.daemons, daemonId, input, agentId),
    }));
    return { agentId };
  },

  reset: () => set({ ...initialState }),
}));
