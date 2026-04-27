"use client";

/**
 * [INPUT]: 依赖 humansApi 的建群能力，依赖 dashboard/session store 提供联系人、Bot 与当前身份
 * [OUTPUT]: 对外提供 CreateRoomModal 组件，完成群名称、描述与初始成员提交
 * [POS]: dashboard 建群入口弹框，被 Sidebar 触发，负责把建群表单收敛为 humans room API 请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { humansApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { common } from "@/lib/i18n/translations/common";
import { createRoomModal } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type { ContactInfo, HumanRoomSummary } from "@/lib/types";

const EMPTY_CONTACTS: ContactInfo[] = [];

interface CreateRoomModalProps {
  onClose: () => void;
  onCreated?: (room: HumanRoomSummary) => void;
}

export default function CreateRoomModal({ onClose, onCreated }: CreateRoomModalProps) {
  const locale = useLanguage();
  const t = createRoomModal[locale];
  const tc = common[locale];
  const contacts = useDashboardChatStore((s) => s.overview?.contacts) ?? EMPTY_CONTACTS;
  const refreshOverview = useDashboardChatStore((s) => s.refreshOverview);
  const refreshHumanRooms = useDashboardSessionStore((s) => s.refreshHumanRooms);
  // Identity signal — treat viewMode as the authoritative "who is acting".
  // viewMode defaults to "human" once the /api/humans/me bootstrap completes,
  // flipping to "agent" only in observer/agent-mode. No unified
  // `activeIdentity` selector exists yet; see report for coordination ask.
  const viewMode = useDashboardSessionStore((s) => s.viewMode);
  const human = useDashboardSessionStore((s) => s.human);
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const identityReady = viewMode === "human" ? Boolean(human) : Boolean(activeAgentId);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [memberQuery, setMemberQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredContacts = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) =>
      c.display_name.toLowerCase().includes(q) ||
      c.contact_agent_id.toLowerCase().includes(q) ||
      (c.alias ?? "").toLowerCase().includes(q),
    );
  }, [contacts, memberQuery]);

  const filteredBots = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    if (!q) return ownedAgents;
    return ownedAgents.filter((a) =>
      a.display_name.toLowerCase().includes(q) ||
      a.agent_id.toLowerCase().includes(q),
    );
  }, [ownedAgents, memberQuery]);

  function toggleMember(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t.nameRequired);
      return;
    }
    if (!identityReady) {
      setError(t.createFailed);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: trimmed,
        description: description.trim(),
        member_ids: Array.from(selected),
      };
      if (viewMode === "agent") {
        setError(t.createFailed);
        return;
      }
      const room = await humansApi.createRoom(body);
      await Promise.all([refreshOverview(), refreshHumanRooms()]);
      onCreated?.(room);
      onClose();
    } catch (err) {
      // ApiError.message already carries the 400/403 body ("detail" field)
      // via extractErrorMessage in lib/api.ts, so surface it verbatim.
      setError(err instanceof Error ? err.message : t.createFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-glass-border bg-deep-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-glass-border px-6 py-4">
          <h2 className="text-lg font-semibold text-text-primary">{t.title}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Basics */}
          <section className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.basicSection}
            </p>
            <label className="block">
              <span className="mb-1 block text-xs text-text-secondary">{t.nameLabel}</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.namePlaceholder}
                maxLength={128}
                className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/60"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-text-secondary">{t.descriptionLabel}</span>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t.descriptionPlaceholder}
                className="w-full resize-none rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/60"
              />
            </label>

            {/* Members */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-text-secondary">
                  {t.membersLabel}
                  {selected.size > 0 && (
                    <span className="ml-2 text-neon-cyan">
                      {selected.size} {t.selected}
                    </span>
                  )}
                </span>
              </div>
              <p className="mb-2 text-[11px] text-text-secondary/70">{t.membersHint}</p>
              {contacts.length === 0 && ownedAgents.length === 0 ? (
                <p className="rounded border border-dashed border-glass-border px-3 py-3 text-xs text-text-secondary/70">
                  {t.noContacts}
                </p>
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-2 rounded border border-glass-border bg-glass-bg px-2">
                    <Search className="h-3.5 w-3.5 text-text-secondary/70" />
                    <input
                      value={memberQuery}
                      onChange={(e) => setMemberQuery(e.target.value)}
                      placeholder={t.searchMembers}
                      className="w-full bg-transparent py-1.5 text-xs text-text-primary outline-none"
                    />
                  </div>

                  {ownedAgents.length > 0 && (
                    <div className="mb-2">
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-secondary/60">
                        {t.myBotsLabel}
                      </p>
                      <div className="max-h-40 overflow-y-auto rounded border border-glass-border">
                        {filteredBots.length === 0 ? (
                          <p className="px-3 py-2 text-[11px] text-text-secondary/60">
                            {t.noBotsMatch}
                          </p>
                        ) : (
                          filteredBots.map((a) => {
                            const checked = selected.has(a.agent_id);
                            return (
                              <label
                                key={a.agent_id}
                                className={`flex cursor-pointer items-center gap-2 border-b border-glass-border/60 px-3 py-2 text-xs last:border-b-0 ${
                                  checked ? "bg-neon-cyan/10" : "hover:bg-glass-bg"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMember(a.agent_id)}
                                  className="accent-neon-cyan"
                                />
                                <span className="flex-1 truncate text-text-primary">
                                  {a.display_name}
                                </span>
                                <span className="font-mono text-[10px] text-text-secondary/70">
                                  {a.agent_id}
                                </span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}

                  {contacts.length > 0 && (
                    <div>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-secondary/60">
                        {t.contactsLabel}
                      </p>
                      <div className="max-h-40 overflow-y-auto rounded border border-glass-border">
                        {filteredContacts.length === 0 ? (
                          <p className="px-3 py-2 text-[11px] text-text-secondary/60">
                            {t.noContactsMatch}
                          </p>
                        ) : (
                          filteredContacts.map((c: ContactInfo) => {
                            const checked = selected.has(c.contact_agent_id);
                            return (
                              <label
                                key={c.contact_agent_id}
                                className={`flex cursor-pointer items-center gap-2 border-b border-glass-border/60 px-3 py-2 text-xs last:border-b-0 ${
                                  checked ? "bg-neon-cyan/10" : "hover:bg-glass-bg"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMember(c.contact_agent_id)}
                                  className="accent-neon-cyan"
                                />
                                <span className="flex-1 truncate text-text-primary">
                                  {c.alias || c.display_name}
                                </span>
                                <span className="font-mono text-[10px] text-text-secondary/70">
                                  {c.contact_agent_id}
                                </span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-glass-border px-6 py-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            {t.cancel}
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !identityReady}
            title={!identityReady ? t.createFailed : undefined}
            className="inline-flex items-center gap-2 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t.creating : t.create}
          </button>
        </div>
      </div>
    </div>
  );
}
