"use client";

import { useMemo } from "react";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type { MentionCandidate } from "@/components/dashboard/MessageComposer";

type MentionCandidateSource = "ownedAgents" | "contacts" | "roomMembers" | "rooms";

interface Options {
  /** The room being composed in. Skipped from room candidates to avoid self-reference. */
  currentRoomId?: string | null;
  /** Include the @all shortcut (group rooms only). */
  includeAll?: boolean;
  /** Extra candidates from room members (pass PublicRoomMember[] when available). */
  roomMembers?: { agent_id: string; display_name: string }[];
  /** Exclude self from candidates. */
  selfId?: string | null;
  /** Candidate sources. Defaults to the legacy broad picker for owner chat. */
  sources?: readonly MentionCandidateSource[];
}

interface BuildMentionCandidatesInput {
  ownedAgents?: { agent_id: string; display_name: string }[];
  contacts?: { contact_agent_id: string; alias: string | null; display_name: string }[];
  rooms?: { room_id: string; name: string }[];
  roomMembers?: { agent_id: string; display_name: string }[];
  currentRoomId?: string | null;
  includeAll?: boolean;
  selfId?: string | null;
  sources?: readonly MentionCandidateSource[];
}

const DEFAULT_SOURCES: readonly MentionCandidateSource[] = ["ownedAgents", "contacts", "roomMembers", "rooms"];

export function buildMentionCandidates({
  ownedAgents = [],
  contacts = [],
  rooms = [],
  roomMembers = [],
  currentRoomId,
  includeAll = false,
  selfId,
  sources = DEFAULT_SOURCES,
}: BuildMentionCandidatesInput): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  if (includeAll) {
    candidates.push({ agent_id: "@all", display_name: "all" });
  }

  const seen = new Set<string>(candidates.map((c) => c.agent_id));
  const sourceSet = new Set(sources);

  const add = (agentId: string, displayName: string) => {
    if (seen.has(agentId) || agentId === selfId) return;
    seen.add(agentId);
    candidates.push({ agent_id: agentId, display_name: displayName, id: agentId });
  };

  if (sourceSet.has("ownedAgents")) {
    for (const a of ownedAgents) {
      add(a.agent_id, a.display_name);
    }
  }

  if (sourceSet.has("contacts")) {
    for (const c of contacts) {
      add(c.contact_agent_id, c.alias || c.display_name);
    }
  }

  if (sourceSet.has("roomMembers")) {
    for (const m of roomMembers) {
      if (m.agent_id.startsWith("ag_") || m.agent_id.startsWith("hu_")) {
        add(m.agent_id, m.display_name);
      }
    }
  }

  if (sourceSet.has("rooms")) {
    for (const r of rooms) {
      if (r.room_id !== currentRoomId && !r.room_id.startsWith("rm_oc_")) {
        if (!seen.has(r.room_id)) {
          seen.add(r.room_id);
          candidates.push({ agent_id: r.room_id, display_name: r.name, id: r.room_id });
        }
      }
    }
  }

  return candidates;
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
  sources,
}: Options = {}): MentionCandidate[] {
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const overview = useDashboardChatStore((s) => s.overview);

  return useMemo<MentionCandidate[]>(() => {
    return buildMentionCandidates({
      ownedAgents,
      contacts: overview?.contacts,
      rooms: overview?.rooms,
      roomMembers,
      selfId,
      currentRoomId,
      includeAll,
      sources,
    });
  }, [ownedAgents, overview, roomMembers, selfId, currentRoomId, includeAll, sources]);
}
