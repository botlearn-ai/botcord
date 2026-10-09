"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Loader2, RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import { spaceError } from "@/lib/team-spaces";
import { grantExpiryLabel } from "@/lib/agent-access";
import { roleBadge, teamAccessApi, type AccessOverview } from "@/lib/team-access";
import AccessBadge from "./AccessBadge";

/** Owners/admins: who can use which Agent across the organization. Hidden on 403. */
export default function AccessOverviewSection({ spaceId }: { spaceId: string }) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const mounted = useRef(false);
  const [data, setData] = useState<AccessOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setLoading(true);
    teamAccessApi
      .overview(spaceId, controller.signal)
      .then((next) => {
        if (!mounted.current) return;
        setData(next);
        setError(null);
      })
      .catch((cause) => {
        if (!mounted.current || controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 403) setForbidden(true);
        else setError(cause);
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [spaceId, version]);

  if (forbidden) return null;
  const counts = data?.counts;
  const tiles = [
    { label: t("协作", "Collaborate"), value: counts?.collaborator },
    { label: t("只读", "Read-only"), value: counts?.consultant },
    { label: t("待处理申请", "Pending requests"), value: counts?.pending_requests },
  ];
  return (
    <div className="space-y-4 border-t border-glass-border pt-5" aria-label={t("Agent 权限总览", "Agent access overview")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h3 className="flex items-center gap-2 font-medium">
            <Eye size={16} />
            {t("Agent 权限总览", "Agent access overview")}
          </h3>
          <p className="mt-2 text-sm leading-6 text-text-secondary">
            {t(
              "组织里谁可以用谁的 Agent。只有组织所有者和管理员能看到；授权由各 Agent 的所有者管理。",
              "Who can use whose Agent in this organization. Only owners and admins see this; each Agent's owner manages its access.",
            )}
          </p>
        </div>
        <button
          className="rounded-lg border border-glass-border p-2 hover:bg-neon-cyan/10 disabled:opacity-50"
          disabled={loading}
          onClick={() => setVersion((v) => v + 1)}
          aria-label={t("刷新权限总览", "Refresh access overview")}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error != null && (
        <p role="alert" className="text-sm text-red-500">
          {spaceError(error, zh)}
        </p>
      )}
      <dl className="grid grid-cols-3 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-glass-border bg-deep-black/40 p-3">
            <dt className="text-[11px] text-text-secondary">{tile.label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{tile.value ?? "—"}</dd>
          </div>
        ))}
      </dl>
      {loading && !data ? (
        <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" />
          {t("正在加载…", "Loading…")}
        </p>
      ) : data && data.grants.length === 0 ? (
        <p className="text-xs text-text-secondary">{t("还没有任何授权。", "No access has been granted yet.")}</p>
      ) : (
        data && (
          <div role="table" aria-label={t("授权列表", "Grants")} className="text-sm">
            <div
              role="row"
              className="hidden grid-cols-[1.2fr_1fr_1fr_auto_1.2fr_1fr] gap-3 border-b border-glass-border pb-2 text-xs text-text-secondary md:grid"
            >
              {[
                t("Agent", "Agent"),
                t("所有者", "Owner"),
                t("使用者", "Grantee"),
                t("权限", "Role"),
                t("工作目录", "Workspace"),
                t("有效期", "Expiry"),
              ].map((h) => (
                <span key={h} role="columnheader">
                  {h}
                </span>
              ))}
            </div>
            {data.grants.map((g) => (
              <div
                key={g.grant_id}
                role="row"
                className="grid grid-cols-2 gap-x-3 gap-y-1 border-b border-glass-border py-3 md:grid-cols-[1.2fr_1fr_1fr_auto_1.2fr_1fr] md:items-center"
              >
                <span role="cell" className="col-span-2 break-words font-medium md:col-span-1">
                  {g.agent_name}
                </span>
                <span role="cell" className="break-words text-xs text-text-secondary md:text-sm md:text-text-primary">
                  <span className="md:hidden">{t("所有者", "Owner")}: </span>
                  {g.owner_name || "—"}
                </span>
                <span role="cell" className="break-words text-xs text-text-secondary md:text-sm md:text-text-primary">
                  <span className="md:hidden">{t("使用者", "Grantee")}: </span>
                  {g.grantee_name || g.grantee_human_id || "—"}
                </span>
                <span role="cell">
                  <AccessBadge info={roleBadge(g.role, zh)} />
                </span>
                <span role="cell" className="break-all text-xs text-text-secondary">
                  {g.role === "collaborator" ? g.workspace_path || t("临时目录", "Temporary directory") : "—"}
                </span>
                <span role="cell" className="col-span-2 text-xs text-text-secondary md:col-span-1">
                  {grantExpiryLabel(g, zh)}
                </span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
