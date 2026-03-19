"use client";

/**
 * [INPUT]: 依赖 react 的 useEffect/useMemo/useRef/useState，依赖 userApi 轮询当前用户 agent 列表，依赖 AgentBindDialog 复用统一创建/关联流程
 * [OUTPUT]: 对外提供 AgentGateModal 组件，在登录但无 agent 时强制阻塞 `/chats` 并自动等待可用身份出现
 * [POS]: dashboard 顶层 agent 准入门禁，优先于任何 rooms/messages 视图与请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Link2, Plus } from "lucide-react";
import { userApi } from "@/lib/api";
import type { UserAgent } from "@/lib/types";
import { useLanguage } from "@/lib/i18n";
import { agentGateModal } from "@/lib/i18n/translations/dashboard";
import AgentBindDialog from "./AgentBindDialog";

interface AgentGateModalProps {
  onAgentReady: (agentId: string) => Promise<void> | void;
}

function pickPreferredAgent(agents: UserAgent[]): UserAgent | null {
  if (agents.length === 0) {
    return null;
  }
  return agents.find((agent) => agent.is_default) ?? agents[0];
}

export default function AgentGateModal({ onAgentReady }: AgentGateModalProps) {
  const locale = useLanguage();
  const t = agentGateModal[locale];
  const [bindMode, setBindMode] = useState<"create" | "link" | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const readyRef = useRef(false);

  const resolveAgents = useCallback(async () => {
    if (readyRef.current) {
      return;
    }
    try {
      const resp = await userApi.getMyAgents();
      const chosen = pickPreferredAgent(resp.agents);
      if (!chosen) {
        return;
      }
      readyRef.current = true;
      setError(null);
      setIsResolving(true);
      await onAgentReady(chosen.agent_id);
    } catch (err: any) {
      readyRef.current = false;
      setIsResolving(false);
      setError(err?.message || t.pollFailed);
    }
  }, [onAgentReady, t.pollFailed]);

  useEffect(() => {
    resolveAgents();

    pollRef.current = setInterval(() => {
      resolveAgents();
    }, 3000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [resolveAgents]);

  return (
    <>
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
        <div className="w-full max-w-2xl rounded-[28px] border border-glass-border bg-deep-black-light p-8 shadow-2xl">
          <div className="mx-auto max-w-xl text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.32em] text-neon-cyan/80">
              {t.communityGate}
            </p>
            <h1 className="mt-4 text-3xl font-bold text-text-primary">
              {t.title}
            </h1>
            <p className="mt-3 text-sm leading-7 text-text-secondary">
              {t.description}
            </p>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <button
              onClick={() => setBindMode("create")}
              disabled={isResolving}
              className="rounded-2xl border border-neon-cyan/40 bg-neon-cyan/10 p-5 text-left transition-all hover:bg-neon-cyan/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="h-5 w-5 text-neon-cyan" />
              <p className="mt-4 text-base font-semibold text-text-primary">{t.createAgent}</p>
              <p className="mt-2 text-sm leading-6 text-text-secondary">{t.createDesc}</p>
            </button>

            <button
              onClick={() => setBindMode("link")}
              disabled={isResolving}
              className="rounded-2xl border border-glass-border bg-glass-bg p-5 text-left transition-all hover:border-neon-cyan/40 hover:bg-glass-bg/80 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Link2 className="h-5 w-5 text-text-primary" />
              <p className="mt-4 text-base font-semibold text-text-primary">{t.linkAgent}</p>
              <p className="mt-2 text-sm leading-6 text-text-secondary">{t.linkDesc}</p>
            </button>
          </div>

          <div className="mt-6 rounded-2xl border border-glass-border bg-deep-black p-4">
            {isResolving ? (
              <div className="flex items-center gap-3 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin text-neon-cyan" />
                <span>{t.entering}</span>
              </div>
            ) : (
              <p className="text-sm leading-6 text-text-secondary">{t.idleHint}</p>
            )}
            {error ? (
              <p className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {bindMode ? (
        <AgentBindDialog
          mode={bindMode}
          onClose={() => setBindMode(null)}
          onSuccess={async () => {
            await resolveAgents();
            setBindMode(null);
          }}
        />
      ) : null}
    </>
  );
}
