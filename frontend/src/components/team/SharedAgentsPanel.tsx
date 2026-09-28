"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2, MessageCircle, RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, teamSpacesApi, type AgentAccessGrant } from "@/lib/team-spaces";
import { grantExpiryLabel, grantRoleLabel } from "@/lib/agent-access";
import { openSharedAgentChat } from "@/lib/shared-agent-chat";
import { teamButton } from "./TeamConversationDialog";

/** Grantee-side list: Agents other organization members shared with you. */
export default function SharedAgentsPanel({ spaceId }: { spaceId: string }) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const router = useRouter();
  const mounted = useRef(false);
  const [agents, setAgents] = useState<AgentAccessGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setLoading(true);
    teamSpacesApi
      .sharedAgents(spaceId, controller.signal)
      .then(({ agents: next }) => {
        if (!mounted.current) return;
        setAgents(next);
        setError(null);
      })
      .catch((cause) => {
        if (mounted.current && !controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [spaceId, version]);

  async function open(grant: AgentAccessGrant) {
    if (opening) return;
    setOpening(grant.id);
    setError(null);
    try {
      await openSharedAgentChat(grant.agent_id, (path) => router.push(path));
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setOpening(null);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-4" aria-label={t("可用 Agent", "Shared Agents")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm leading-6 text-text-secondary">
          {t(
            "组织成员授权给你使用的 Agent。点击后会在个人消息里打开与它的私信。",
            "Agents teammates have shared with you. Opening one starts a direct message in your personal Messages.",
          )}
        </p>
        <button
          className={teamButton}
          disabled={loading}
          onClick={() => setVersion((v) => v + 1)}
          aria-label={t("刷新可用 Agent", "Refresh shared Agents")}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error != null && (
        <p role="alert" className="rounded-xl border border-red-500/30 p-4 text-sm text-red-500">
          {spaceError(error, zh)}
        </p>
      )}
      {loading ? (
        <p role="status" className="flex items-center justify-center gap-2 py-8 text-xs text-text-secondary">
          <Loader2 size={16} className="animate-spin" />
          {t("正在加载…", "Loading…")}
        </p>
      ) : agents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-glass-border px-4 py-10 text-center text-text-secondary">
          <Bot size={28} className="mx-auto mb-3 opacity-50" />
          <p className="text-sm">
            {t("还没有成员授权 Agent 给你。", "No one has shared an Agent with you yet.")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {agents.map((grant) => (
            <li key={grant.id}>
              <button
                className="flex w-full items-center gap-3 rounded-2xl border border-glass-border bg-glass-bg p-4 text-left transition-colors hover:border-neon-cyan/40 focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:opacity-60"
                disabled={opening != null}
                onClick={() => void open(grant)}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-deep-black text-neon-cyan">
                  <Bot size={19} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {grant.agent_name ?? grant.agent_id}
                    </span>
                    <span className="rounded-md bg-neon-cyan/10 px-1.5 py-0.5 text-[11px] text-neon-cyan">
                      {grantRoleLabel(grant.role, zh)}
                    </span>
                  </p>
                  <p className="mt-1 truncate text-xs text-text-secondary">
                    {t("授权人", "Shared by")}: {grant.granted_by_name ?? "—"} ·{" "}
                    {grantExpiryLabel(grant, zh)}
                  </p>
                </div>
                {opening === grant.id ? (
                  <Loader2 size={18} className="shrink-0 animate-spin text-neon-cyan" />
                ) : (
                  <MessageCircle size={18} className="shrink-0 text-text-secondary" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
