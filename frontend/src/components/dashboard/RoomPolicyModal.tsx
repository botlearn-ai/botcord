"use client";

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

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Loader2, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/api";
import type { PublicRoomMember } from "@/lib/types";
import {
  usePolicyStore,
  type AttentionMode,
  type RoomPolicyEffective,
} from "@/store/usePolicyStore";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur">
      <div className="w-full max-w-lg rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Bell className="h-4 w-4 text-neon-cyan" />
              <h2 className="text-base font-semibold text-text-primary">本房间回复策略</h2>
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">
              只控制 {agentDisplayName ? `${agentDisplayName} ` : ""}({agentId})
              在当前房间是否被唤醒；不影响谁能发消息到房间。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && !data ? (
          <div className="flex items-center gap-2 rounded-xl border border-glass-border bg-glass-bg/40 px-3 py-3 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : error && !data ? (
          <div className="rounded-xl border border-red-400/20 bg-red-400/5 px-3 py-3 text-sm text-red-300">
            加载失败：{error}
          </div>
        ) : data && effective ? (
          isDM ? (
            <div className="rounded-xl border border-neon-cyan/25 bg-neon-cyan/5 px-4 py-4">
              <div className="text-sm font-medium text-neon-cyan">私聊始终唤醒</div>
              <p className="mt-1 text-xs text-text-secondary">
                DM 房间当前强制使用所有消息唤醒，不能在房间级静音或覆盖。
              </p>
            </div>
          ) : (
            <>
              <EffectiveBadge effective={effective} hasOverride={hasOverride} />

              <div className="mt-4">
                <div className="mb-2 text-xs font-medium uppercase tracking-normal text-text-secondary">
                  快速静音
                </div>
                <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void apply(() => snoozeRoom(agentId, roomId, 60))
                  }
                  disabled={busy}
                  className="rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-1.5 text-xs text-text-primary transition-colors hover:bg-glass-bg disabled:opacity-50"
                >
                  静音 1 小时
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void apply(() =>
                      snoozeRoom(agentId, roomId, snoozeMinutesUntilMidnight()),
                    )
                  }
                  disabled={busy}
                  className="rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-1.5 text-xs text-text-primary transition-colors hover:bg-glass-bg disabled:opacity-50"
                >
                  静音到今天结束
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void apply(() => snoozeRoom(agentId, roomId, 7 * 24 * 60))
                  }
                  disabled={busy}
                  className="rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-1.5 text-xs text-text-primary transition-colors hover:bg-glass-bg disabled:opacity-50"
                >
                  静音 7 天
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void apply(() =>
                      putRoomOverride(agentId, roomId, { attention_mode: "muted" }),
                    )
                  }
                  disabled={busy}
                  className="rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-1.5 text-xs text-text-primary transition-colors hover:bg-glass-bg disabled:opacity-50"
                >
                  永久静音
                </button>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-glass-border bg-glass-bg/30 p-3">
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="text-sm font-medium text-neon-cyan transition-colors hover:text-neon-cyan/80"
                >
                  {expanded ? "收起本房间专属策略" : "设置本房间专属策略"}
                </button>

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
              </div>

              {hasOverride ? (
                <div className="mt-4">
                  <button
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
                    className="rounded-lg border border-glass-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
                  >
                    恢复默认（继承全局）
                  </button>
                </div>
              ) : null}

              {error ? (
                <p className="mt-3 text-xs text-red-300">{error}</p>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </div>
  );
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
    <div className="rounded-xl border border-glass-border bg-glass-bg/40 px-3 py-3">
      <div className="text-xs text-text-secondary">当前</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-primary">
          {modeLabel(effective.mode)}
        </span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] ${
            effective.source === "override"
              ? "border-neon-cyan/30 bg-neon-cyan/5 text-neon-cyan"
              : "border-glass-border bg-glass-bg text-text-secondary"
          }`}
        >
          {sourceText}
        </span>
        {mutedActive ? (
          <span className="rounded-full border border-yellow-400/30 bg-yellow-400/5 px-2 py-0.5 text-[10px] text-yellow-300">
            静音至 {new Date(effective.muted_until!).toLocaleString()}
          </span>
        ) : null}
      </div>
      {effective.mode === "keyword" && effective.keywords.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {effective.keywords.map((k) => (
            <span
              key={k}
              className="rounded-full border border-glass-border bg-glass-bg px-2 py-0.5 text-[10px] text-text-secondary"
            >
              {k}
            </span>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-xs text-text-secondary">
        {effective.source === "override" || hasOverride
          ? "此房间正在使用专属策略；修改 Bot 默认回复不会覆盖这里。"
          : "此房间继承 Bot 默认房间回复策略。"}
      </p>
    </div>
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
            <input
              type="radio"
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
              <span className="text-xs text-text-tertiary">尚未配置关键词</span>
            ) : (
              keywords.map((k) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1 rounded-full border border-neon-cyan/30 bg-neon-cyan/5 px-2 py-0.5 text-xs text-neon-cyan"
                >
                  {k}
                  <button
                    type="button"
                    onClick={() => setKeywords((prev) => prev.filter((v) => v !== k))}
                    className="rounded-full p-0.5 hover:bg-neon-cyan/10"
                    aria-label={`移除关键词 ${k}`}
                    disabled={busy}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))
            )}
          </div>
          <input
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
            className="rounded-xl border border-glass-border bg-deep-black/40 px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-neon-cyan/40 focus:outline-none disabled:opacity-50"
          />
        </div>
      ) : null}

      {mode === "allowed_senders" ? (
        <div className="mt-3 rounded-xl border border-glass-border bg-deep-black/30 p-2">
          {membersLoading ? (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-text-secondary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              加载成员中…
            </div>
          ) : members.length === 0 ? (
            <p className="px-1 py-2 text-xs text-text-tertiary">未能加载房间成员</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {members.map((member) => {
                const checked = allowedSenderIds.includes(member.agent_id);
                return (
                  <label
                    key={member.agent_id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-glass-bg/50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) {
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
                      }}
                      className="accent-neon-cyan"
                      disabled={busy}
                    />
                    <span className="min-w-0 flex-1 truncate">{member.display_name}</span>
                    <span className="shrink-0 text-[10px] text-text-tertiary">
                      {member.participant_type === "human" ? "人" : "Agent"}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex justify-end">
        {currentMode !== mode || mode === "keyword" ? (
          <button
            type="button"
            onClick={() => {
              setMode(currentMode);
              setKeywords(currentKeywords);
              setAllowedSenderIds(currentAllowedSenderIds);
            }}
            disabled={busy}
            className="mr-2 inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            撤销更改
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onApply(mode, keywords, allowedSenderIds)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/15 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          应用到本房间
        </button>
      </div>
    </div>
  );
}
