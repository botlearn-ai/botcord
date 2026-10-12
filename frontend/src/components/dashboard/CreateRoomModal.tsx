"use client";
import EmptyState from "@/components/ui/EmptyState";
import Field from "@/components/ui/Field";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Input";
import Button from "@/components/ui/Button";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
/**
 * [INPUT]: 依赖 humansApi 的创建房间能力，依赖 dashboard/session store 提供联系人、Bot 与当前身份
 * [OUTPUT]: 对外提供 CreateRoomModal 组件，完成房间名称、描述与初始成员提交
 * [POS]: dashboard 创建房间入口弹框，被 Sidebar 触发，负责把创建房间表单收敛为 humans room API 请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { humansApi } from "@/lib/api";
import { animateOverlayPanelEnter, animateOverlayPanelExit, animatePop, cleanupAnime } from "@/lib/anime";
import { useLanguage } from "@/lib/i18n";
import { common } from "@/lib/i18n/translations/common";
import { createRoomModal } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import DashboardMultiSelect, { type DashboardMultiSelectGroup } from "./DashboardMultiSelect";
import type { ContactInfo, HumanRoomSummary } from "@/lib/types";

const EMPTY_CONTACTS: ContactInfo[] = [];

interface CreateRoomModalProps {
  onClose: () => void;
  onCreated?: (room: HumanRoomSummary) => void;
}

export default withDashboardOverlayPortal(CreateRoomModal);

function CreateRoomModal({ onClose, onCreated }: CreateRoomModalProps) {
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const errorAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  const memberGroups = useMemo<DashboardMultiSelectGroup[]>(() => {
    const groups: DashboardMultiSelectGroup[] = [];
    if (ownedAgents.length > 0) {
      groups.push({
        label: t.myBotsLabel,
        options: ownedAgents.map((agent) => ({
          value: agent.agent_id,
          label: agent.display_name,
          sublabel: agent.agent_id,
          badge: "Bot",
          tone: "cyan",
        })),
      });
    }
    if (contacts.length > 0) {
      groups.push({
        label: t.contactsLabel,
        options: contacts.map((contact) => ({
          value: contact.contact_agent_id,
          label: contact.alias || contact.display_name,
          sublabel: contact.contact_agent_id,
          badge: "Contact",
          tone: "green",
        })),
      });
    }
    return groups;
  }, [contacts, ownedAgents, t.contactsLabel, t.myBotsLabel]);

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
        default_invite: true,
      };
      if (viewMode === "agent") {
        setError(t.createFailed);
        return;
      }
      const room = await humansApi.createRoom(body);
      await Promise.all([refreshOverview(), refreshHumanRooms()]);
      onCreated?.(room);
      closeWithMotion();
    } catch (err) {
      // ApiError.message already carries the 400/403 body ("detail" field)
      // via extractErrorMessage in lib/api.ts, so surface it verbatim.
      setError(err instanceof Error ? err.message : t.createFailed);
    } finally {
      setSaving(false);
    }
  }

  const closeWithMotion = useCallback(() => {
    if (saving || closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, onClose, saving]);

  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; } });
    return () => cleanupAnime(animationRef.current);
  }, []);

  useEffect(() => {
    if (!error || !errorRef.current) return;
    cleanupAnime(errorAnimationRef.current);
    errorAnimationRef.current = animatePop(errorRef.current);
    return () => cleanupAnime(errorAnimationRef.current);
  }, [error]);

  return (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} title={<>{t.title}</>} busy={saving} overlayClassName="z-50" className="max-w-lg overflow-hidden">
        <div className="border-b border-glass-border px-6 py-4">
          <h2 className="text-lg font-semibold text-text-primary">{t.title}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Basics */}
          <section className="space-y-3">
            <p className="text-xs font-semibold text-text-secondary">
              {t.basicSection}
            </p>
            <Field label={<>{t.nameLabel}</>} className="block">

              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.namePlaceholder}
                maxLength={128}
                className="w-full"
              />
            </Field>

            <Field label={<>{t.descriptionLabel}</>} className="block">

              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t.descriptionPlaceholder}
                className="w-full"
              />
            </Field>

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
              <p className="mb-2 text-xs text-text-secondary">{t.membersHint}</p>
              {contacts.length === 0 && ownedAgents.length === 0 ? (
                <EmptyState compact bordered title={<>{t.noContacts}</>} />
              ) : (
                <DashboardMultiSelect
                  value={Array.from(selected)}
                  onChange={(next) => setSelected(new Set(next))}
                  groups={memberGroups}
                  placeholder={t.membersLabel}
                  searchPlaceholder={t.searchMembers}
                  emptyLabel={`${t.noBotsMatch} ${t.noContactsMatch}`}
                  selectedLabel={(count) => (count > 0 ? `${count} ${t.selected}` : t.selected)}
                />
              )}
            </div>
          </section>

          {error && (
            <Alert tone="danger" ref={errorRef} >
              {error}
            </Alert>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-glass-border px-6 py-3">
          <Button variant="secondary"
            onClick={closeWithMotion}
            disabled={saving}

          >
            {t.cancel}
          </Button>
          <Button variant="primary"
            onClick={handleCreate}
            disabled={saving || !identityReady}
            title={!identityReady ? t.createFailed : undefined}

          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t.creating : t.create}
          </Button>
        </div>
      </DialogSurface>
  );
}
