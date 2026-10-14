"use client";

/**
 * [INPUT]: humansApi.listPendingApprovals / resolvePendingApproval + i18n locale
 * [OUTPUT]: A collapsible panel listing pending approval-queue entries for
 *           Agents the user owns, with inline approve/reject controls.
 * [POS]: frontend surface for the Human-owned-Agent gate (backend
 *        app/routers/humans.py::AgentApprovalQueue). Rendered at the top of
 *        the /chats/contacts/requests tab.
 * [PROTOCOL]: keep request/response types in sync with
 *             backend/app/routers/humans.py schemas.
 */

import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { humansApi } from "@/lib/api";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useLanguage } from "@/lib/i18n";
import { pendingApprovalsPanel } from "@/lib/i18n/translations/dashboard";
import type { PendingApproval } from "@/lib/types";
import { BotCordLoadingBlock } from "@/components/ui/BotCordLoader";

type ActionState = { id: string; decision: "approve" | "reject" } | null;

export default function PendingApprovalsPanel() {
  const locale = useLanguage();
  const t = pendingApprovalsPanel[locale];
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>(null);
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const agentNames = useMemo(
    () => new Map((ownedAgents ?? []).map((a) => [a.agent_id, a.display_name])),
    [ownedAgents],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await humansApi.listPendingApprovals();
      setApprovals(res.approvals);
    } catch (err: any) {
      // Not fatal: the panel stays hidden when the Human surface is
      // unavailable (e.g. legacy user without human_id, or pre-migration).
      setError(err?.message || t.errorLoad);
      setApprovals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolve = useCallback(
    async (id: string, decision: "approve" | "reject") => {
      setAction({ id, decision });
      try {
        await humansApi.resolvePendingApproval(id, decision);
        setApprovals((prev) => prev.filter((a) => a.id !== id));
      } catch (err: any) {
        setError(err?.message || t.errorResolve);
      } finally {
        setAction(null);
      }
    },
    [],
  );

  if (loading && approvals.length === 0) {
    return (
      <Card padding="sm" className="mb-4">
        <BotCordLoadingBlock
          label={t.loading}
          size="sm"
          className="justify-start"
        />
      </Card>
    );
  }

  if (!loading && approvals.length === 0) {
    // Hidden when empty so it does not clutter the Requests tab for users
    // without owned Agents. Silent error swallow: see refresh().
    return null;
  }

  return (
    <Card as="section" padding="md"
      aria-label="Pending approvals on agents you own"
      className="mb-4"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {t.title}
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            {t.subtitle}
          </p>
        </div>
        <Button variant="secondary" size="sm"
          type="button"
          onClick={() => void refresh()}

        >
          {t.refresh}
        </Button>
      </header>

      {error ? (
        <p className="mb-3 text-xs text-danger">{error}</p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {approvals.map((entry) => {
          const isApproving =
            action?.id === entry.id && action.decision === "approve";
          const isRejecting =
            action?.id === entry.id && action.decision === "reject";
          const processing = isApproving || isRejecting;
          const payload = entry.payload as {
            from_display_name?: string;
            from_participant_id?: string;
            message?: string;
          };
          const fromLabel = payload.from_display_name || "unknown";
          return (
            <Card as="li" padding="sm"
              key={entry.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-xs text-text-secondary">
                    <Badge tone="accent" >
                      {entry.kind.replace(/_/g, " ")}
                    </Badge>
                    <span className="truncate text-xs">
                      {t.forAgent} {agentNames.get(entry.agent_id) ?? t.unknownAgent}
                    </span>
                  </p>
                  <p className="mt-1 truncate text-sm font-semibold text-text-primary">
                    {fromLabel}
                  </p>
                  {payload.message ? (
                    <p className="mt-2 line-clamp-3 text-xs text-text-secondary">
                      {payload.message}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  <Button variant="secondary" size="sm"
                    type="button"
                    onClick={() => void resolve(entry.id, "approve")}
                    disabled={processing}
                    className="inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {isApproving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
                    {t.approve}
                  </Button>
                  <Button variant="danger" size="sm"
                    type="button"
                    onClick={() => void resolve(entry.id, "reject")}
                    disabled={processing}
                    className="inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {isRejecting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
                    {t.reject}
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </ul>
    </Card>
  );
}
