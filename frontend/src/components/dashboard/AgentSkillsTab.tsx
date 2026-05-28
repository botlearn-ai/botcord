"use client";

/**
 * [INPUT]: agentId + Hub skill snapshot API
 * [OUTPUT]: AgentSkillsTab — lists daemon-sniffed runtime-global/workspace skills and refreshes the snapshot
 * [POS]: Bot Settings / My Bots drawer Skills tab content
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Cpu, FolderKanban, Globe2, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { userApi } from "@/lib/api";
import {
  createAgentSkillsRequestGuard,
  groupAgentSkillsByRuntime,
  normalizeAgentSkillSnapshot,
  type AgentSkill,
  type AgentSkillSnapshot,
  type AgentSkillSource,
} from "@/lib/agent-skills";
import { useLanguage } from "@/lib/i18n";

const COPY = {
  en: {
    title: "Skills",
    subtitle: "Daemon-sniffed skills snapshotted for this Bot",
    runtimeGlobal: "Runtime-global",
    workspace: "Workspace",
    sourceDetail: "Source",
    unknownRuntime: "unknown",
    refresh: "Refresh skills",
    loading: "Loading skills...",
    refreshing: "Refreshing...",
    empty: "No skills found in the latest snapshot",
    loadFailed: "Failed to load skills",
    daemonUnavailable: "Daemon is offline or this Bot is not daemon-hosted",
    lastSniffed: "Last sniffed",
    runtime: "Runtime",
    noDescription: "No description provided",
  },
  zh: {
    title: "Skills",
    subtitle: "Daemon 已嗅探并为此 Bot 快照的技能",
    runtimeGlobal: "运行时全局",
    workspace: "工作区",
    sourceDetail: "来源",
    unknownRuntime: "未知",
    refresh: "刷新技能",
    loading: "正在加载技能...",
    refreshing: "刷新中...",
    empty: "最新快照中没有发现技能",
    loadFailed: "读取技能失败",
    daemonUnavailable: "Daemon 未在线或此 Bot 未由 daemon 托管",
    lastSniffed: "上次嗅探",
    runtime: "运行环境",
    noDescription: "暂无描述",
  },
} as const;

function skillsErrorMessage(err: unknown, fallback: string, daemonUnavailable: string): string {
  const message = err instanceof Error ? err.message : String(err || fallback);
  if (message === "daemon_offline" || message === "agent_not_daemon_hosted") {
    return daemonUnavailable;
  }
  return message || fallback;
}

function formatTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMillis(value?: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return formatTimestamp(new Date(value).toISOString());
}

function sourceIcon(source: AgentSkillSource) {
  return source === "runtime-global" ? (
    <Globe2 className="h-3.5 w-3.5" />
  ) : (
    <FolderKanban className="h-3.5 w-3.5" />
  );
}

function SkillCard({
  skill,
  sourceLabel,
  sourceDetailLabel,
}: {
  skill: AgentSkill;
  sourceLabel: string;
  sourceDetailLabel: string;
}) {
  return (
    <li className="rounded-xl border border-glass-border bg-glass-bg/35 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">{skill.name}</span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-neon-cyan/25 bg-neon-cyan/5 px-2 py-0.5 text-[10px] font-medium text-neon-cyan">
              {sourceIcon(skill.source)}
              {sourceLabel}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary/80">
            {skill.description}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {skill.runtime ? (
          <span className="rounded border border-glass-border bg-deep-black/30 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
            {skill.runtime}
          </span>
        ) : null}
        {skill.sourceDetail ? (
          <span className="rounded border border-glass-border bg-deep-black/30 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
            {sourceDetailLabel}: {skill.sourceDetail}
          </span>
        ) : null}
        {skill.profile ? (
          <span className="rounded border border-glass-border bg-deep-black/30 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
            {skill.profile}
          </span>
        ) : null}
        {skill.path ? (
          <span className="max-w-full truncate rounded border border-glass-border bg-deep-black/30 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
            {skill.path}
          </span>
        ) : null}
        {skill.updatedAt || skill.mtimeMs ? (
          <span className="rounded border border-glass-border bg-deep-black/30 px-1.5 py-0.5 text-[10px] text-text-secondary">
            {formatTimestamp(skill.updatedAt) ?? formatMillis(skill.mtimeMs)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export default function AgentSkillsTab({ agentId }: { agentId: string }) {
  const locale = useLanguage();
  const copy = COPY[locale];
  const [snapshot, setSnapshot] = useState<AgentSkillSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGuardRef = useRef(createAgentSkillsRequestGuard(agentId));
  const visibleSnapshot = snapshot?.agentId === agentId ? snapshot : null;

  const runtimeGroups = useMemo(
    () =>
      groupAgentSkillsByRuntime(
        visibleSnapshot?.skills ?? [],
        visibleSnapshot?.runtime ?? copy.unknownRuntime,
      ),
    [copy.unknownRuntime, visibleSnapshot?.runtime, visibleSnapshot?.skills],
  );
  const total = visibleSnapshot?.skills.length ?? 0;
  const sniffedAt = formatTimestamp(visibleSnapshot?.sniffedAt);

  const loadSkills = async () => {
    const requestAgentId = agentId;
    const requestToken = requestGuardRef.current.begin(requestAgentId, "load");
    setLoading(true);
    setError(null);
    try {
      const data = await userApi.listAgentSkills(requestAgentId);
      const nextSnapshot = normalizeAgentSkillSnapshot(data, requestAgentId);
      if (!requestGuardRef.current.canCommit(requestToken) || nextSnapshot.agentId !== requestAgentId) return;
      setSnapshot(nextSnapshot);
      setLoaded(true);
    } catch (err) {
      if (!requestGuardRef.current.canCommit(requestToken)) return;
      setError(skillsErrorMessage(err, copy.loadFailed, copy.daemonUnavailable));
      setLoaded(true);
    } finally {
      if (requestGuardRef.current.canFinishOperation(requestToken)) {
        setLoading(false);
      }
    }
  };

  const refreshSkills = async () => {
    const requestAgentId = agentId;
    const requestToken = requestGuardRef.current.begin(requestAgentId, "refresh");
    setRefreshing(true);
    setError(null);
    try {
      const data = await userApi.refreshAgentSkills(requestAgentId);
      const nextSnapshot = normalizeAgentSkillSnapshot(data, requestAgentId);
      if (!requestGuardRef.current.canCommit(requestToken) || nextSnapshot.agentId !== requestAgentId) return;
      setSnapshot(nextSnapshot);
      setLoaded(true);
    } catch (err) {
      if (!requestGuardRef.current.canCommit(requestToken)) return;
      setError(skillsErrorMessage(err, copy.loadFailed, copy.daemonUnavailable));
    } finally {
      if (requestGuardRef.current.canFinishOperation(requestToken)) {
        setRefreshing(false);
      }
    }
  };

  useLayoutEffect(() => {
    requestGuardRef.current.setAgentId(agentId);
    setSnapshot(null);
    setLoaded(false);
    setError(null);
    setLoading(false);
    setRefreshing(false);
    return () => {
      requestGuardRef.current.invalidate();
    };
  }, [agentId]);

  useEffect(() => {
    if (!loaded && !loading) {
      void loadSkills();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, loaded, loading]);

  const sourceLabels: Record<AgentSkillSource, string> = {
    "runtime-global": copy.runtimeGlobal,
    workspace: copy.workspace,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Sparkles className="h-4 w-4 text-neon-cyan" />
            {copy.title}
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary">{copy.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void refreshSkills()}
          disabled={loading || refreshing}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-glass-border bg-glass-bg text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
          title={copy.refresh}
          aria-label={copy.refresh}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-glass-border bg-glass-bg/30 px-3 py-2">
          <div className="text-[10px] uppercase tracking-normal text-text-secondary/65">{copy.title}</div>
          <div className="mt-1 text-lg font-semibold text-text-primary">{total}</div>
        </div>
        <div className="rounded-xl border border-glass-border bg-glass-bg/30 px-3 py-2">
          <div className="text-[10px] uppercase tracking-normal text-text-secondary/65">
            {visibleSnapshot?.runtime ? copy.runtime : copy.lastSniffed}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-text-primary">
            {visibleSnapshot?.runtime ?? sniffedAt ?? "-"}
          </div>
        </div>
      </div>

      {sniffedAt ? (
        <p className="text-[11px] text-text-secondary/65">
          {copy.lastSniffed}: {sniffedAt}
        </p>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      {loading && total === 0 ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-glass-bg/60" />
          ))}
        </div>
      ) : total === 0 ? (
        <div className="rounded-xl border border-glass-border bg-glass-bg/40 px-4 py-8 text-center text-sm text-text-secondary">
          {copy.empty}
        </div>
      ) : (
        <div className="space-y-5">
          {runtimeGroups.map((group) => (
            <section key={group.runtime} className="space-y-3">
              <div className="flex items-center justify-between gap-2 border-b border-glass-border/70 pb-2 text-[11px] font-semibold uppercase tracking-normal text-text-secondary/70">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 text-neon-cyan" />
                  <span className="truncate font-mono">{group.runtime}</span>
                </span>
                <span>{group.skills.length}</span>
              </div>
              {(["workspace", "runtime-global"] as AgentSkillSource[]).map((source) => {
                const skills = group.sources[source];
                if (skills.length === 0) return null;
                const label = sourceLabels[source];
                return (
                  <div key={`${group.runtime}:${source}`} className="space-y-2">
                    <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-normal text-text-secondary/70">
                      <span className="flex items-center gap-1.5">
                        {sourceIcon(source)}
                        {label}
                      </span>
                      <span>{skills.length}</span>
                    </div>
                    <ul className="space-y-2">
                      {skills.map((skill) => (
                        <SkillCard
                          key={skill.id}
                          skill={{
                            ...skill,
                            description: skill.description || copy.noDescription,
                          }}
                          sourceLabel={label}
                          sourceDetailLabel={copy.sourceDetail}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          ))}
          {runtimeGroups.length === 0 ? (
            <div className="rounded-xl border border-glass-border/70 bg-glass-bg/20 px-3 py-3 text-xs text-text-secondary/60">
              {copy.empty}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
