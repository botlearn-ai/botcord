/**
 * [INPUT]: BFF endpoints under /api/users/me/agents/openclaw/*
 * [OUTPUT]: useOpenclawHostStore — list registered OpenClaw hosts, issue
 *           install tickets, poll bind-code status, provision agents on
 *           an already-online host
 * [POS]: dashboard store backing the OpenClaw branch of CreateAgentDialog
 * [PROTOCOL]: update header on changes
 */

import { create } from "zustand";

export interface OpenclawHost {
  id: string;
  label: string | null;
  online: boolean;
  last_seen_at: string | null;
  revoked_at: string | null;
  agent_count: number;
  created_at: string;
}

export interface OpenclawInstallTicket {
  bindCode: string;
  bindTicket: string;
  nonce: string;
  expiresAt: number; // unix seconds
  installCommand: string;
}

export interface BindCodeStatus {
  status: "pending" | "claimed" | "revoked" | "expired";
  agentId?: string;
}

export class OpenclawProvisionError extends Error {
  constructor(public code: string, message: string, public detail?: string) {
    super(message);
    this.name = "OpenclawProvisionError";
  }
}

interface State {
  hosts: OpenclawHost[];
  loaded: boolean;
  loading: boolean;
}

interface Actions {
  refresh: () => Promise<void>;
  issueInstall: (input: { name: string; bio?: string }) => Promise<OpenclawInstallTicket>;
  pollBindCode: (bindCode: string) => Promise<BindCodeStatus>;
  revokeBindCode: (bindCode: string) => Promise<void>;
  provisionOnHost: (
    hostId: string,
    input: { name: string; bio?: string },
  ) => Promise<{ agentId: string }>;
  renameHost: (hostId: string, label: string | null) => Promise<void>;
  revokeHost: (hostId: string) => Promise<void>;
}

const initialState: State = {
  hosts: [],
  loaded: false,
  loading: false,
};

async function readError(res: Response): Promise<{ code: string; detail?: string }> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return { code: body.detail };
    if (body?.detail && typeof body.detail.code === "string") {
      return { code: body.detail.code, detail: body.detail.host_message };
    }
    if (typeof body?.error === "string") return { code: body.error };
  } catch {
    /* ignore */
  }
  return { code: `http_${res.status}` };
}

export const useOpenclawHostStore = create<State & Actions>()((set, get) => ({
  ...initialState,

  async refresh() {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await fetch("/api/users/me/agents/openclaw/hosts", {
        cache: "no-store",
      });
      if (!res.ok) {
        set({ loading: false });
        return;
      }
      const data = (await res.json()) as { hosts: OpenclawHost[] };
      set({ hosts: data.hosts ?? [], loaded: true, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  async issueInstall(input) {
    const res = await fetch("/api/users/me/agents/openclaw/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.name, bio: input.bio }),
    });
    if (!res.ok) {
      const err = await readError(res);
      throw new OpenclawProvisionError(err.code, err.detail || err.code);
    }
    const data = await res.json();
    return {
      bindCode: data.bind_code,
      bindTicket: data.bind_ticket,
      nonce: data.nonce,
      expiresAt: data.expires_at,
      installCommand: data.install_command,
    };
  },

  async pollBindCode(bindCode) {
    const res = await fetch(
      `/api/users/me/agents/bind-ticket/${encodeURIComponent(bindCode)}`,
      { cache: "no-store" },
    );
    if (res.status === 404) return { status: "expired" };
    if (!res.ok) return { status: "pending" };
    const data = await res.json();
    if (data.status === "claimed" && typeof data.agent_id === "string") {
      return { status: "claimed", agentId: data.agent_id };
    }
    if (data.status === "expired") return { status: "expired" };
    if (data.status === "revoked") return { status: "revoked" };
    return { status: "pending" };
  },

  async revokeBindCode(bindCode) {
    await fetch(
      `/api/users/me/agents/bind-ticket/${encodeURIComponent(bindCode)}`,
      { method: "DELETE" },
    ).catch(() => {});
  },

  async provisionOnHost(hostId, input) {
    const res = await fetch("/api/users/me/agents/openclaw/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        openclaw_host_id: hostId,
        name: input.name,
        bio: input.bio,
      }),
    });
    if (!res.ok) {
      const err = await readError(res);
      throw new OpenclawProvisionError(err.code, err.detail || err.code, err.detail);
    }
    const data = await res.json();
    if (typeof data.agent_id !== "string") {
      throw new OpenclawProvisionError("missing_agent_id", "missing agent_id in response");
    }
    return { agentId: data.agent_id };
  },

  async renameHost(hostId, label) {
    await fetch(
      `/api/users/me/agents/openclaw/hosts/${encodeURIComponent(hostId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      },
    );
    await get().refresh();
  },

  async revokeHost(hostId) {
    await fetch(
      `/api/users/me/agents/openclaw/hosts/${encodeURIComponent(hostId)}`,
      { method: "DELETE" },
    );
    await get().refresh();
  },
}));
