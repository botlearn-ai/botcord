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
import { Loader2, X } from "lucide-react";
import {
  usePolicyStore,
  type AttentionMode,
  type RoomPolicyEffective,
} from "@/store/usePolicyStore";

const ATTENTION_OPTIONS: { value: AttentionMode; label: string }[] = [
  { value: "always", label: "全部回复" },
  { value: "mention_only", label: "仅被@" },
  { value: "keyword", label: "关键词" },
  { value: "muted", label: "静音" },
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
  roomId,
  onClose,
}: {
  agentId: string;
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

  const draftKeywords = useMemo(() => {
    if (data?.override?.keywords) return data.override.keywords;
    if (effective?.keywords) return effective.keywords;
    return [];
  }, [data?.override?.keywords, effective?.keywords]);

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
      <div className="w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-text-primary">我的回复策略</h2>
            <p className="mt-0.5 text-xs text-text-secondary">
              控制此 Agent 在该房间内的注意力（是否唤醒回复）。
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
            <div className="rounded-xl border border-glass-border bg-glass-bg/40 px-3 py-3 text-sm text-text-secondary">
              一对一始终回复
            </div>
          ) : (
            <>
              <EffectiveBadge effective={effective} hasOverride={hasOverride} />

              <div className="mt-4 flex flex-wrap gap-2">
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

              <div className="mt-4 rounded-xl border border-glass-border bg-glass-bg/30 p-3">
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="text-sm text-neon-cyan transition-colors hover:text-neon-cyan/80"
                >
                  {expanded ? "▾ 改为本群专属" : "▸ 改为本群专属"}
                </button>

                {expanded ? (
                  <OverrideForm
                    currentMode={data.override?.attention_mode ?? effective.mode}
                    currentKeywords={draftKeywords}
                    busy={busy}
                    onApply={(mode, keywords) =>
                      void apply(() =>
                        putRoomOverride(agentId, roomId, {
                          attention_mode: mode,
                          keywords: mode === "keyword" ? keywords : null,
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
        ? "本群专属"
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
    </div>
  );
}

function OverrideForm({
  currentMode,
  currentKeywords,
  busy,
  onApply,
}: {
  currentMode: AttentionMode;
  currentKeywords: string[];
  busy: boolean;
  onApply: (mode: AttentionMode, keywords: string[]) => void;
}) {
  const [mode, setMode] = useState<AttentionMode>(currentMode);
  const [keywords, setKeywords] = useState<string[]>(currentKeywords);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setMode(currentMode);
  }, [currentMode]);
  useEffect(() => {
    setKeywords(currentKeywords);
  }, [currentKeywords]);

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
            className="flex cursor-pointer items-center gap-2 text-sm text-text-primary"
          >
            <input
              type="radio"
              name="room_attention"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              className="accent-neon-cyan"
              disabled={busy}
            />
            {opt.label}
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

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => onApply(mode, keywords)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/15 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          应用到本群
        </button>
      </div>
    </div>
  );
}
