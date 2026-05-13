/**
 * [INPUT]: zustand store; BFF /api/agents/[agentId]/policy and per-room policy/snooze routes
 * [OUTPUT]: usePolicyStore — global per-agent admission/attention policy + per-room overrides
 * [POS]: dashboard policy state for /settings/policy and the room policy card
 * [PROTOCOL]: update header on changes
 */

import { create } from "zustand";

// TODO(realtime): subscribe to policy_updated to invalidate cache once the
// daemon control frame is wired into the dashboard realtime channel.

export type ContactPolicy = "open" | "contacts_only" | "whitelist" | "closed";
export type RoomInvitePolicy = "open" | "contacts_only" | "closed";
export type AttentionMode =
  | "always"
  | "mention_only"
  | "keyword"
  | "allowed_senders"
  | "muted";
export type PolicySource = "global" | "override" | "dm_forced";

export interface AgentPolicy {
  contact_policy: ContactPolicy;
  allow_agent_sender: boolean;
  allow_human_sender: boolean;
  room_invite_policy: RoomInvitePolicy;
  default_attention: AttentionMode;
  attention_keywords: string[];
}

export interface AgentPolicyPatch {
  contact_policy?: ContactPolicy;
  allow_agent_sender?: boolean;
  allow_human_sender?: boolean;
  room_invite_policy?: RoomInvitePolicy;
  default_attention?: AttentionMode;
  attention_keywords?: string[];
}

export interface RoomPolicyOverride {
  attention_mode: AttentionMode | null;
  keywords: string[] | null;
  allowed_sender_ids: string[] | null;
  muted_until: string | null;
  updated_at: string;
}

export interface RoomPolicyEffective {
  mode: AttentionMode;
  keywords: string[];
  allowed_sender_ids: string[];
  muted_until: string | null;
  source: PolicySource;
}

export interface RoomPolicyResponse {
  effective: RoomPolicyEffective;
  override: RoomPolicyOverride | null;
  inherits_global: boolean;
}

export interface RoomOverridePatch {
  // Omit a key to leave unchanged; explicit null clears (= inherit).
  attention_mode?: AttentionMode | null;
  keywords?: string[] | null;
  allowed_sender_ids?: string[] | null;
}

interface PolicyState {
  globalByAgent: Record<string, AgentPolicy>;
  globalLoading: Record<string, boolean>;
  roomEffectiveByKey: Record<string, RoomPolicyResponse>;
  roomLoading: Record<string, boolean>;

  loadGlobal: (agentId: string) => Promise<AgentPolicy>;
  patchGlobal: (agentId: string, patch: AgentPolicyPatch) => Promise<AgentPolicy>;
  loadRoomPolicy: (agentId: string, roomId: string) => Promise<RoomPolicyResponse>;
  putRoomOverride: (
    agentId: string,
    roomId: string,
    body: RoomOverridePatch,
  ) => Promise<RoomPolicyResponse>;
  deleteRoomOverride: (agentId: string, roomId: string) => Promise<void>;
  snoozeRoom: (
    agentId: string,
    roomId: string,
    minutes: number,
  ) => Promise<RoomPolicyResponse>;
  invalidate: (agentId: string, roomId?: string) => void;
}

function roomKey(agentId: string, roomId: string): string {
  return `${agentId}:${roomId}`;
}

async function readErr(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  let detail: string | undefined;
  let messageKey: string | undefined;
  try {
    const json = JSON.parse(text) as { detail?: unknown; message_key?: unknown };
    if (typeof json.detail === "string") detail = json.detail;
    if (typeof json.message_key === "string") messageKey = json.message_key;
  } catch {
    // fall through
  }
  const err = new Error(detail || messageKey || `HTTP ${res.status}`);
  (err as Error & { status?: number; messageKey?: string }).status = res.status;
  if (messageKey) {
    (err as Error & { status?: number; messageKey?: string }).messageKey = messageKey;
  }
  return err;
}

export const usePolicyStore = create<PolicyState>((set, get) => ({
  globalByAgent: {},
  globalLoading: {},
  roomEffectiveByKey: {},
  roomLoading: {},

  async loadGlobal(agentId) {
    set((s) => ({ globalLoading: { ...s.globalLoading, [agentId]: true } }));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/policy`, {
        cache: "no-store",
      });
      if (!res.ok) throw await readErr(res);
      const policy = (await res.json()) as AgentPolicy;
      set((s) => ({
        globalByAgent: { ...s.globalByAgent, [agentId]: policy },
      }));
      return policy;
    } finally {
      set((s) => {
        const next = { ...s.globalLoading };
        delete next[agentId];
        return { globalLoading: next };
      });
    }
  },

  async patchGlobal(agentId, patch) {
    const prev = get().globalByAgent[agentId];
    const optimistic: AgentPolicy | undefined = prev
      ? { ...prev, ...patch }
      : undefined;
    if (optimistic) {
      set((s) => ({ globalByAgent: { ...s.globalByAgent, [agentId]: optimistic } }));
    }
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw await readErr(res);
      const policy = (await res.json()) as AgentPolicy;
      set((s) => ({ globalByAgent: { ...s.globalByAgent, [agentId]: policy } }));
      return policy;
    } catch (err) {
      // rollback
      if (prev) {
        set((s) => ({ globalByAgent: { ...s.globalByAgent, [agentId]: prev } }));
      }
      throw err;
    }
  },

  async loadRoomPolicy(agentId, roomId) {
    const key = roomKey(agentId, roomId);
    set((s) => ({ roomLoading: { ...s.roomLoading, [key]: true } }));
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(roomId)}/policy`,
        { cache: "no-store" },
      );
      if (!res.ok) throw await readErr(res);
      const data = (await res.json()) as RoomPolicyResponse;
      set((s) => ({ roomEffectiveByKey: { ...s.roomEffectiveByKey, [key]: data } }));
      return data;
    } finally {
      set((s) => {
        const next = { ...s.roomLoading };
        delete next[key];
        return { roomLoading: next };
      });
    }
  },

  async putRoomOverride(agentId, roomId, body) {
    const key = roomKey(agentId, roomId);
    const prev = get().roomEffectiveByKey[key];
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(roomId)}/policy`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw await readErr(res);
      const data = (await res.json()) as RoomPolicyResponse;
      set((s) => ({ roomEffectiveByKey: { ...s.roomEffectiveByKey, [key]: data } }));
      return data;
    } catch (err) {
      if (prev) {
        set((s) => ({ roomEffectiveByKey: { ...s.roomEffectiveByKey, [key]: prev } }));
      }
      throw err;
    }
  },

  async deleteRoomOverride(agentId, roomId) {
    const key = roomKey(agentId, roomId);
    const prev = get().roomEffectiveByKey[key];
    set((s) => {
      const next = { ...s.roomEffectiveByKey };
      delete next[key];
      return { roomEffectiveByKey: next };
    });
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(roomId)}/policy`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) throw await readErr(res);
    } catch (err) {
      if (prev) {
        set((s) => ({ roomEffectiveByKey: { ...s.roomEffectiveByKey, [key]: prev } }));
      }
      throw err;
    }
  },

  async snoozeRoom(agentId, roomId, minutes) {
    const key = roomKey(agentId, roomId);
    const prev = get().roomEffectiveByKey[key];
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(roomId)}/snooze`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minutes }),
        },
      );
      if (!res.ok) throw await readErr(res);
      const data = (await res.json()) as RoomPolicyResponse;
      set((s) => ({ roomEffectiveByKey: { ...s.roomEffectiveByKey, [key]: data } }));
      return data;
    } catch (err) {
      if (prev) {
        set((s) => ({ roomEffectiveByKey: { ...s.roomEffectiveByKey, [key]: prev } }));
      }
      throw err;
    }
  },

  invalidate(agentId, roomId) {
    if (roomId) {
      const key = roomKey(agentId, roomId);
      set((s) => {
        const next = { ...s.roomEffectiveByKey };
        delete next[key];
        return { roomEffectiveByKey: next };
      });
      return;
    }
    set((s) => {
      const nextGlobal = { ...s.globalByAgent };
      delete nextGlobal[agentId];
      const nextRooms = { ...s.roomEffectiveByKey };
      const prefix = `${agentId}:`;
      for (const k of Object.keys(nextRooms)) {
        if (k.startsWith(prefix)) delete nextRooms[k];
      }
      return { globalByAgent: nextGlobal, roomEffectiveByKey: nextRooms };
    });
  },
}));
