"use client";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import Card from "@/components/ui/Card";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";

/**
 * [INPUT]: agentId + roomId; usePolicyStore for effective + override state
 * [OUTPUT]: RoomPolicyModal — per-room "我的回复策略" card. Shows the effective
 *          attention policy with inherits/override badge, lets the user expand
 *          a per-room override (radio + keyword input), exposes quick snooze
 *          buttons (1h / today / forever), and a "恢复默认" reset.
 *
 *          DM rooms ("rm_dm_*") only show the effective state — controls hide.
 *
 * [POS]: Mounted from RoomHeader as a modal (the dashboard has no permanent
 *        right-side info drawer; the design doc's "right-side drawer card" is
 *        approximated by an overlay popover here. Revisit when a true room
 *        info drawer lands.)
 * [PROTOCOL]: update header on changes
 */

import Radio from "@/components/ui/Radio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Loader2, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/api";
import type { PublicRoomMember } from "@/lib/types";
import { BotCordLoadingBlock } from "@/components/ui/BotCordLoader";
import {
  usePolicyStore,
  type AttentionMode,
  type RoomPolicyEffective,
} from "@/store/usePolicyStore";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";
import DashboardOverlayPortal from "./DashboardOverlayPortal";

const ATTENTION_OPTIONS: { value: AttentionMode; label: string; hint: string }[] = [
  { value: "always", label: "所有消息", hint: "本房间任何新消息都会唤醒 Bot" },
  { value: "mention_only", label: "仅 @ 我", hint: "只有被 @ 或明确点名时唤醒" },
  { value: "muted", label: "静音", hint: "本房间不主动唤醒 Bot" },
  { value: "keyword", label: "关键词命中", hint: "消息包含关键词时唤醒" },
  { value: "allowed_senders", label: "仅允许成员", hint: "只回复指定成员发出的消息" },
];

function modeLabel(mode: AttentionMode): string {
  return ATTENTION_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

function snoozeMinutesUntilMidnight(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const diffMs = next.getTime() - now.getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  // Backend caps at 43200 (30 days); midnight is always within range.
  return Math.min(minutes, 43200);
}

export default function RoomPolicyModal({
  agentId,
  agentDisplayName,
  roomId,
  onClose,
}: {
  agentId: string;
  agentDisplayName?: string;
  roomId: string;
  onClose: () => void;
}) {
  const isDM = roomId.startsWith("rm_dm_");
  const key = `${agentId}:${roomId}`;

  const data = usePolicyStore((s) => s.roomEffectiveByKey[key]);
  const loading = usePolicyStore((s) => Boolean(s.roomLoading[key]));
  const loadRoomPolicy = usePolicyStore((s) => s.loadRoomPolicy);
  const putRoomOverride = usePolicyStore((s) => s.putRoomOverride);
  const deleteRoomOverride = usePolicyStore((s) => s.deleteRoomOverride);
  const snoozeRoom = usePolicyStore((s) => s.snoozeRoom);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        await loadRoomPolicy(agentId, roomId);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, roomId, loadRoomPolicy]);

  const effective: RoomPolicyEffective | null = data?.effective ?? null;
  const hasOverride = data?.override != null;

  useEffect(() => {
    if (hasOverride) setExpanded(true);
  }, [hasOverride]);

  useEffect(() => {
    if (isDM) return;
    let cancelled = false;
    setMembersLoading(true);
    void api.getRoomMembers(roomId)
      .then((result) => {
        if (!cancelled) setMembers(result.members);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isDM, roomId]);

  const draftKeywords = useMemo(() => {
    if (data?.override?.keywords) return data.override.keywords;
    if (effective?.keywords) return effective.keywords;
    return [];
  }, [data?.override?.keywords, effective?.keywords]);

  const draftAllowedSenderIds = useMemo(() => {
    if (data?.override?.allowed_sender_ids) return data.override.allowed_sender_ids;
    if (effective?.allowed_sender_ids) return effective.allowed_sender_ids;
    return [];
  }, [data?.override?.allowed_sender_ids, effective?.allowed_sender_ids]);

  const apply = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const closeWithMotion = useCallback(() => {
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      contentSelector: "[data-motion-item]",
      onComplete: onClose,
    });
  }, [onClose]);

  useEffect(() => {
    if (!mounted) return;
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
      contentSelector: "[data-motion-item]",
    });

    return () => {

      cleanupAnime(animationRef.current);
    };
  }, [closeWithMotion, mounted]);

  const modal = (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} title={<>本房间回复策略</>} overlayClassName="z-[80]" className="max-w-lg overflow-y-auto p-5">
        <div data-motion-item className="mb-4 flex items-start justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Bell className="h-4 w-4 text-neon-cyan" />
              <h2 className="text-base font-semibold text-text-primary">本房间回复策略</h2>
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">
              只控制 {agentDisplayName || "该 Bot"}
              在当前房间是否被唤醒；不影响谁能发消息到房间。
            </p>
          </div>
          <IconButton label="关闭"
            type="button"
            onClick={closeWithMotion}

            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        {loading && !data ? (
          <Card padding="none" data-motion-item className="flex items-center gap-2 px-3 py-3">
            <BotCordLoadingBlock
              label="加载中…"
              size="sm"
              className="justify-start"
            />
          </Card>
        ) : error && !data ? (
          <Alert tone="danger" data-motion-item >
            加载失败：{error}
          </Alert>
        ) : data && effective ? (
          isDM ? (
            <Card padding="none" data-motion-item className="px-4 py-4">
              <div className="text-sm font-medium text-neon-cyan">私聊始终唤醒</div>
              <p className="mt-1 text-xs text-text-secondary">
                DM 房间当前强制使用所有消息唤醒，不能在房间级静音或覆盖。
              </p>
            </Card>
          ) : (
            <>
              <EffectiveBadge effective={effective} hasOverride={hasOverride} />

              <div data-motion-item className="mt-4">
                <div className="mb-2 text-xs font-medium text-text-secondary">
                  快速静音
                </div>
                <div className="flex flex-wrap gap-2">
                <Button variant="secondary"
                  type="button"
                  onClick={() =>
                    void apply(() => snoozeRoom(agentId, roomId, 60))
                  }
                  disabled={busy}

                >
                  静音 1 小时
                </Button>
                <Button variant="secondary"
                  type="button"
                  onClick={() =>
                    void apply(() =>
                      snoozeRoom(agentId, roomId, snoozeMinutesUntilMidnight()),
                    )
                  }
                  disabled={busy}

                >
                  静音到今天结束
                </Button>
                <Button variant="secondary"
                  type="button"
                  onClick={() =>
                    void apply(() => snoozeRoom(agentId, roomId, 7 * 24 * 60))
                  }
                  disabled={busy}

                >
                  静音 7 天
                </Button>
                <Button variant="secondary"
                  type="button"
                  onClick={() =>
                    void apply(() =>
                      putRoomOverride(agentId, roomId, { attention_mode: "muted" }),
                    )
                  }
                  disabled={busy}

                >
                  永久静音
                </Button>
                </div>
              </div>

              <Card padding="none" data-motion-item className="mt-4 p-3">
                <Button variant="ghost"
                  type="button"
                  onClick={() => setExpanded((v) => !v)}

                >
                  {expanded ? "收起本房间专属策略" : "设置本房间专属策略"}
                </Button>

                {expanded ? (
                  <OverrideForm
                    currentMode={data.override?.attention_mode ?? effective.mode}
                    currentKeywords={draftKeywords}
                    currentAllowedSenderIds={draftAllowedSenderIds}
                    members={members}
                    membersLoading={membersLoading}
                    busy={busy}
                    onApply={(mode, keywords, allowedSenderIds) =>
                      void apply(() =>
                        putRoomOverride(agentId, roomId, {
                          attention_mode: mode,
                          keywords: mode === "keyword" ? keywords : null,
                          allowed_sender_ids:
                            mode === "allowed_senders" ? allowedSenderIds : null,
                        }),
                      )
                    }
                  />
                ) : null}
              </Card>

              {hasOverride ? (
                <div data-motion-item className="mt-4">
                  <Button variant="secondary"
                    type="button"
                    onClick={() =>
                      void apply(() => deleteRoomOverride(agentId, roomId)).then(
                        () => {
                          // re-load to refresh effective view after override removed
                          void loadRoomPolicy(agentId, roomId);
                        },
                      )
                    }
                    disabled={busy}

                  >
                    恢复默认（继承全局）
                  </Button>
                </div>
              ) : null}

              {error ? (
                <Alert tone="danger" className="mt-3">{error}</Alert>
              ) : null}
            </>
          )
        ) : null}
      </DialogSurface>
  );

  if (!mounted) return null;
  return <DashboardOverlayPortal layer="nested">{modal}</DashboardOverlayPortal>;
}

function EffectiveBadge({
  effective,
  hasOverride,
}: {
  effective: RoomPolicyEffective;
  hasOverride: boolean;
}) {
  const mutedActive =
    effective.muted_until && new Date(effective.muted_until).getTime() > Date.now();
  const sourceText =
    effective.source === "dm_forced"
      ? "私聊（强制）"
      : effective.source === "override" || hasOverride
        ? "本房间专属"
        : "继承全局";
  return (
    <Card padding="none" className="px-3 py-3">
      <div className="text-xs text-text-secondary">当前</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-primary">
          {modeLabel(effective.mode)}
        </span>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${
            effective.source === "override"
              ? "border-neon-cyan/30 bg-neon-cyan/5 text-neon-cyan"
              : "border-glass-border bg-glass-bg text-text-secondary"
          }`}
        >
          {sourceText}
        </span>
        {mutedActive ? (
          <Badge tone="warning" >
            静音至 {new Date(effective.muted_until!).toLocaleString()}
          </Badge>
        ) : null}
      </div>
      {effective.mode === "keyword" && effective.keywords.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {effective.keywords.map((k) => (
            <Badge
              key={k}

            >
              {k}
            </Badge>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-xs text-text-secondary">
        {effective.source === "override" || hasOverride
          ? "此房间正在使用专属策略；修改 Bot 默认回复不会覆盖这里。"
          : "此房间继承 Bot 默认房间回复策略。"}
      </p>
    </Card>
  );
}

function OverrideForm({
  currentMode,
  currentKeywords,
  currentAllowedSenderIds,
  members,
  membersLoading,
  busy,
  onApply,
}: {
  currentMode: AttentionMode;
  currentKeywords: string[];
  currentAllowedSenderIds: string[];
  members: PublicRoomMember[];
  membersLoading: boolean;
  busy: boolean;
  onApply: (
    mode: AttentionMode,
    keywords: string[],
    allowedSenderIds: string[],
  ) => void;
}) {
  const [mode, setMode] = useState<AttentionMode>(currentMode);
  const [keywords, setKeywords] = useState<string[]>(currentKeywords);
  const [allowedSenderIds, setAllowedSenderIds] = useState<string[]>(
    currentAllowedSenderIds,
  );
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setMode(currentMode);
  }, [currentMode]);
  useEffect(() => {
    setKeywords(currentKeywords);
  }, [currentKeywords]);
  useEffect(() => {
    setAllowedSenderIds(currentAllowedSenderIds);
  }, [currentAllowedSenderIds]);

  const addKeyword = () => {
    const trimmed = draft.trim();
    if (!trimmed || keywords.includes(trimmed)) {
      setDraft("");
      return;
    }
    setKeywords((prev) => [...prev, trimmed]);
    setDraft("");
  };

  return (
    <div className="mt-3">
      <div className="flex flex-col gap-1.5">
        {ATTENTION_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors ${
              mode === opt.value
                ? "border-neon-cyan/40 bg-neon-cyan/5"
                : "border-glass-border bg-transparent hover:bg-glass-bg/50"
            }`}
          >
            <Radio

              name="room_attention"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              className="mt-1 accent-neon-cyan"
              disabled={busy}
            />
            <span>
              <span className="block text-sm text-text-primary">{opt.label}</span>
              <span className="block text-xs text-text-secondary">{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "keyword" ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {keywords.length === 0 ? (
              <span className="text-xs text-text-secondary">尚未配置关键词</span>
            ) : (
              keywords.map((k) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1 rounded-full border border-neon-cyan/30 bg-neon-cyan/5 px-2 py-0.5 text-xs text-neon-cyan"
                >
                  {k}
                  <IconButton label={`移除关键词 ${k}`}
                    type="button"
                    onClick={() => setKeywords((prev) => prev.filter((v) => v !== k))}

                    aria-label={`移除关键词 ${k}`}
                    disabled={busy}
                  >
                    <X className="h-3 w-3" />
                  </IconButton>
                </span>
              ))
            )}
          </div>
          <Input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addKeyword();
              }
            }}
            onBlur={addKeyword}
            disabled={busy}
            placeholder="输入关键词后按回车添加"

          />
        </div>
      ) : null}

      {mode === "allowed_senders" ? (
        <Card padding="none" className="mt-3 p-2">
          {membersLoading ? (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-text-secondary">
              <BotCordLoadingBlock
                label="加载成员中…"
                size="sm"
                className="justify-start"
              />
            </div>
          ) : members.length === 0 ? (
            <p className="px-1 py-2 text-xs text-text-secondary">未能加载房间成员</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {members.map((member) => {
                const checked = allowedSenderIds.includes(member.agent_id);
                return (
                  <Checkbox checked={checked} onCheckedChange={(checked) => {
                        if (checked) {
                          setAllowedSenderIds((prev) =>
                            prev.includes(member.agent_id)
                              ? prev
                              : [...prev, member.agent_id],
                          );
                        } else {
                          setAllowedSenderIds((prev) =>
                            prev.filter((id) => id !== member.agent_id),
                          );
                        }
                      }} disabled={busy} label={<><span className="min-w-0 flex-1 truncate">{member.display_name}</span><span className="shrink-0 text-xs text-text-secondary">
                      {member.participant_type === "human" ? "人" : "Agent"}
                    </span></>} />
                );
              })}
            </div>
          )}
        </Card>
      ) : null}

      <div className="mt-3 flex justify-end">
        {currentMode !== mode || mode === "keyword" ? (
          <Button variant="secondary"
            type="button"
            onClick={() => {
              setMode(currentMode);
              setKeywords(currentKeywords);
              setAllowedSenderIds(currentAllowedSenderIds);
            }}
            disabled={busy}
            className="mr-2"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            撤销更改
          </Button>
        ) : null}
        <Button variant="primary"
          type="button"
          onClick={() => onApply(mode, keywords, allowedSenderIds)}
          disabled={busy}

        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          应用到本房间
        </Button>
      </div>
    </div>
  );
}
