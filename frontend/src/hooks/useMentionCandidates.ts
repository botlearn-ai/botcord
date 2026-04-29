"use client";

import { useMemo } from "react";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type { MentionCandidate } from "@/components/dashboard/MessageComposer";

interface Options {
  /** The room being composed in. Skipped from room candidates to avoid self-reference. */
  currentRoomId?: string | null;
  /** Include the @all shortcut (group rooms only). */
  includeAll?: boolean;
  /** Extra candidates from room members (pass PublicRoomMember[] when available). */
  roomMembers?: { agent_id: string; display_name: string }[];
  /** Exclude self from candidates. */
  selfId?: string | null;
}

/**
 * Builds @ mention candidates from already-loaded store data — no extra fetches.
 * Order: own agents → contacts → room members not in contacts → other rooms.
 */
export function useMentionCandidates({
  currentRoomId,
  includeAll = false,
  roomMembers = [],
  selfId,
}: Options = {}): MentionCandidate[] {
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const overview = useDashboardChatStore((s) => s.overview);

  return useMemo<MentionCandidate[]>(() => {
    const candidates: MentionCandidate[] = [];
    if (includeAll) {
      candidates.push({ agent_id: "@all", display_name: "all" });
    }

    const seen = new Set<string>(candidates.map((c) => c.agent_id));

    const add = (agentId: string, displayName: string) => {
      if (seen.has(agentId) || agentId === selfId) return;
      seen.add(agentId);
      candidates.push({ agent_id: agentId, display_name: displayName, id: agentId });
    };

    // 1. Own agents
    for (const a of ownedAgents) {
      add(a.agent_id, a.display_name);
    }

    // 2. Contacts (people first)
    for (const c of overview?.contacts ?? []) {
      add(c.contact_agent_id, c.alias || c.display_name);
    }

    // 3. Room members not already covered by contacts (includes hu_ humans)
    for (const m of roomMembers) {
      if (m.agent_id.startsWith("ag_") || m.agent_id.startsWith("hu_")) {
        add(m.agent_id, m.display_name);
      }
    }

    // 4. Other rooms (last, for cross-room references)
    for (const r of overview?.rooms ?? []) {
      if (r.room_id !== currentRoomId && !r.room_id.startsWith("rm_oc_")) {
        if (!seen.has(r.room_id)) {
          seen.add(r.room_id);
          candidates.push({ agent_id: r.room_id, display_name: r.name, id: r.room_id });
        }
      }
    }

    return candidates;
  }, [ownedAgents, overview, roomMembers, selfId, currentRoomId, includeAll]);
}
