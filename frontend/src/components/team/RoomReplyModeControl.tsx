"use client";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

import Select from "@/components/ui/Select";
import { useLanguage } from "@/lib/i18n";
import {
  parseKeywords,
  replyModeLabel,
  type ReplyMode,
} from "@/lib/team-access";
import { usePolicyStore } from "@/store/usePolicyStore";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Choice = ReplyMode | "inherit";
const EDITABLE: Choice[] = ["inherit", "always", "mention_only", "keyword"];

/**
 * Owner-only: when an Agent replies in one room. Saves through the existing
 * per-room policy API (PUT override / DELETE = follow the Agent default).
 * Loads the current policy itself unless `initial` is given.
 */
export default function RoomReplyModeControl({
  agentId,
  roomId,
  label,
  initial,
  onSaved,
}: {
  agentId: string;
  roomId: string;
  label: string;
  initial?: { mode: ReplyMode; keywords: string[]; inherits: boolean };
  onSaved?: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const mounted = useRef(false);
  const [state, setState] = useState(initial ?? null);
  const [keywords, setKeywords] = useState(
    (initial?.keywords ?? []).join(", "),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    mounted.current = true;
    if (!initial) {
      usePolicyStore
        .getState()
        .loadRoomPolicy(agentId, roomId)
        .then((policy) => {
          if (!mounted.current) return;
          setState({
            mode: policy.effective.mode,
            keywords: policy.effective.keywords,
            inherits: policy.inherits_global,
          });
          setKeywords(policy.effective.keywords.join(", "));
        })
        .catch(() => mounted.current && setError(true));
    }
    return () => {
      mounted.current = false;
    };
    // `initial` is only a seed; reloading on identity changes is enough.
  }, [agentId, roomId]);

  async function save(
    choice: Choice,
    words: string[] = parseKeywords(keywords),
  ) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const store = usePolicyStore.getState();
      if (choice === "inherit") {
        await store.deleteRoomOverride(agentId, roomId);
        const policy = await store.loadRoomPolicy(agentId, roomId);
        if (mounted.current)
          setState({
            mode: policy.effective.mode,
            keywords: policy.effective.keywords,
            inherits: true,
          });
      } else {
        const policy = await store.putRoomOverride(agentId, roomId, {
          attention_mode: choice,
          keywords: choice === "keyword" ? words : null,
        });
        if (mounted.current)
          setState({
            mode: policy.effective.mode,
            keywords: policy.effective.keywords,
            inherits: false,
          });
      }
      onSaved?.();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (!state)
    return error ? (
      <p className="text-xs text-danger">
        {t("回复设置加载失败", "Couldn't load reply settings")}
      </p>
    ) : (
      <Loader2
        size={13}
        className="animate-spin text-text-secondary"
        aria-label={t("正在加载", "Loading")}
      />
    );

  const value: Choice = state.inherits ? "inherit" : state.mode;
  const options = EDITABLE.includes(value) ? EDITABLE : [...EDITABLE, value];
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={label}

          value={value}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as Choice;
            // Keyword mode needs words first; it is saved from the keyword field.
            if (next === "keyword" && !parseKeywords(keywords).length) {
              setState({ ...state, mode: "keyword", inherits: false });
              return;
            }
            void save(next);
          }}
        >
          {options.map((choice) => (
            <option key={choice} value={choice}>
              {choice === "inherit" && state.inherits
                ? `${replyModeLabel("inherit", zh)}: ${replyModeLabel(state.mode, zh)}`
                : replyModeLabel(choice, zh)}
            </option>
          ))}
        </Select>
        {busy && (
          <Loader2 size={13} className="animate-spin text-text-secondary" />
        )}
        {error && (
          <span className="text-xs text-danger">
            {t("保存失败，请重试", "Save failed. Try again.")}
          </span>
        )}
      </div>
      {value === "keyword" && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const words = parseKeywords(keywords);
            if (words.length) void save("keyword", words);
          }}
        >
          <Input
            className="min-w-0 flex-1"
            value={keywords}
            disabled={busy}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder={t("关键词，用逗号分隔", "Keywords, comma separated")}
            aria-label={t("关键词", "Keywords")}
          />
          <Button
            variant="primary"
            size="sm"
            type="submit"
            className="shrink-0"
            disabled={busy || !parseKeywords(keywords).length}
          >
            {t("保存", "Save")}
          </Button>
        </form>
      )}
    </div>
  );
}
