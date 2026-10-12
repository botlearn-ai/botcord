"use client";
import Alert from "@/components/ui/Alert";
import { BotCordLoader } from "@/components/ui/BotCordLoader";
import IconButton from "@/components/ui/IconButton";
import MetricCard from "@/components/ui/MetricCard";
import Table, {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";

import { grantExpiryLabel } from "@/lib/agent-access";
import { ApiError } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import {
  roleBadge,
  teamAccessApi,
  type AccessOverview,
} from "@/lib/team-access";
import { spaceError } from "@/lib/team-spaces";
import { Eye, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import AccessBadge from "./AccessBadge";

/** Owners/admins: who can use which Agent across the organization. Hidden on 403. */
export default function AccessOverviewSection({
  spaceId,
}: {
  spaceId: string;
}) {
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
        if (cause instanceof ApiError && cause.status === 403)
          setForbidden(true);
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
    {
      label: t("待处理申请", "Pending requests"),
      value: counts?.pending_requests,
    },
  ];
  return (
    <div
      className="space-y-4 border-t border-glass-border pt-5"
      aria-label={t("Agent 权限总览", "Agent access overview")}
    >
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
        <IconButton
          disabled={loading}
          onClick={() => setVersion((v) => v + 1)}
          label={t("刷新权限总览", "Refresh access overview")}
        >
          <RefreshCw size={16} />
        </IconButton>
      </div>
      {error != null && <Alert tone="danger">{spaceError(error, zh)}</Alert>}
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((tile) => (
          <MetricCard
            key={tile.label}
            label={tile.label}
            value={tile.value ?? "—"}
          />
        ))}
      </div>
      {loading && !data ? (
        <BotCordLoader
          size="sm"
          className="w-full py-6"
          label={t("正在加载…", "Loading…")}
        />
      ) : data && data.grants.length === 0 ? (
        <p className="text-xs text-text-secondary">
          {t("还没有任何授权。", "No access has been granted yet.")}
        </p>
      ) : (
        data && (
          <Table aria-label={t("授权列表", "Grants")}>
            <TableHead>
              <TableRow>
                {[
                  t("Agent", "Agent"),
                  t("所有者", "Owner"),
                  t("使用者", "Grantee"),
                  t("权限", "Role"),
                  t("工作目录", "Workspace"),
                  t("有效期", "Expiry"),
                ].map((h) => (
                  <TableHeader key={h}>{h}</TableHeader>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {data.grants.map((g) => (
                <TableRow key={g.grant_id}>
                  <TableCell>{g.agent_name}</TableCell>
                  <TableCell>{g.owner_name || "—"}</TableCell>
                  <TableCell>
                    {g.grantee_name || g.grantee_human_id || "—"}
                  </TableCell>
                  <TableCell>
                    <AccessBadge info={roleBadge(g.role, zh)} />
                  </TableCell>
                  <TableCell>
                    {g.role === "collaborator"
                      ? g.workspace_path || t("临时目录", "Temporary directory")
                      : "—"}
                  </TableCell>
                  <TableCell>{grantExpiryLabel(g, zh)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      )}
    </div>
  );
}
