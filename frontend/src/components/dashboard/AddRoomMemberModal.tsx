/**
 * [INPUT]: 依赖 session/chat store 的 ownedAgents 与 contacts，依赖 humansApi.addRoomMember 执行人类侧邀请加入房间
 * [OUTPUT]: 对外提供 AddRoomMemberModal 组件，支持手动选择好友或自己的 Agent 批量加入当前房间
 * [POS]: dashboard 成员面板的邀请入口，把已有房间邀请 API 接到可搜索、可选择的前端弹窗
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { humansApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { agentBrowser } from "@/lib/i18n/translations/dashboard";
import DashboardMultiSelect from "./DashboardMultiSelect";
import type { ContactInfo, UserAgent } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

type CandidateSource = "contact" | "owned_agent";

interface InviteCandidate {
  participantId: string;
  displayName: string;
  source: CandidateSource;
}

interface AddRoomMemberModalProps {
  roomId: string;
  existingMemberIds: string[];
  onClose: () => void;
  onAdded: () => Promise<void> | void;
}

const EMPTY_CONTACTS: ContactInfo[] = [];
const EMPTY_AGENTS: UserAgent[] = [];

export default function AddRoomMemberModal({
  roomId,
  existingMemberIds,
  onClose,
  onAdded,
}: AddRoomMemberModalProps) {
  const locale = useLanguage();
  const t = agentBrowser[locale];
  const contacts = useDashboardChatStore((state) => state.overview?.contacts) ?? EMPTY_CONTACTS;
  const ownedAgents = useDashboardSessionStore((state) => state.ownedAgents) ?? EMPTY_AGENTS;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const existing = new Set(existingMemberIds);
    const merged = new Map<string, InviteCandidate>();

    for (const agent of ownedAgents) {
      if (existing.has(agent.agent_id)) continue;
      merged.set(agent.agent_id, {
        participantId: agent.agent_id,
        displayName: agent.display_name,
        source: "owned_agent",
      });
    }

    for (const contact of contacts) {
      if (existing.has(contact.contact_agent_id)) continue;
      if (merged.has(contact.contact_agent_id)) continue;
      merged.set(contact.contact_agent_id, {
        participantId: contact.contact_agent_id,
        displayName: contact.alias || contact.display_name,
        source: "contact",
      });
    }

    return Array.from(merged.values())
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [contacts, existingMemberIds, ownedAgents]);

  const handleAddMembers = async () => {
    if (selectedIds.size === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      for (const participantId of selectedIds) {
        await humansApi.addRoomMember(roomId, { participant_id: participantId, role: "member" });
      }
      await onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.addMemberFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex h-[min(760px,calc(100dvh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-glass-border bg-deep-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{t.addMemberTitle}</h2>
            <p className="mt-1 text-xs text-text-secondary">{t.addMemberDescription}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
            aria-label={t.closeAddMemberModal}
            title={t.closeAddMemberModal}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {error ? (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-between text-xs text-text-secondary">
            <span>{t.addMemberSelectableCount.replace("{count}", String(selectedIds.size))}</span>
            <span>{t.addMemberCandidateCount.replace("{count}", String(candidates.length))}</span>
          </div>

          {candidates.length === 0 ? (
            <div className="rounded border border-dashed border-glass-border px-4 py-6 text-sm text-text-secondary/70">
              {t.noAddableMembers}
            </div>
          ) : (
            <DashboardMultiSelect
              value={Array.from(selectedIds)}
              onChange={(next) => setSelectedIds(new Set(next))}
              options={candidates.map((candidate) => ({
                value: candidate.participantId,
                label: candidate.displayName,
                sublabel: candidate.participantId,
                badge: candidate.source === "owned_agent" ? t.addMemberSourceOwnedAgent : t.addMemberSourceFriend,
                tone: candidate.source === "owned_agent" ? "cyan" : "green",
              }))}
              placeholder={t.addMembersAction}
              searchPlaceholder={t.searchAddableMembers}
              emptyLabel={t.noAddableMembers}
              selectedLabel={(count) => t.addMemberSelectableCount.replace("{count}", String(count))}
              panelClassName="max-h-[min(440px,calc(100dvh-20rem))]"
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-glass-border px-6 py-4">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            {t.permCancel}
          </button>
          <button
            onClick={() => void handleAddMembers()}
            disabled={saving || selectedIds.size === 0}
            className="inline-flex items-center gap-2 rounded border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? t.addingMembers : t.addMembersAction}
          </button>
        </div>
      </div>
    </div>
  );
}
