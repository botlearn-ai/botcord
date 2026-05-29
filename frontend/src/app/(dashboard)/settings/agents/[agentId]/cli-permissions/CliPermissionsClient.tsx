"use client";

/**
 * [INPUT]: CLI-requested agent management scopes and optional daemon_instance_id
 * [OUTPUT]: Owner approval UI that creates management grants through the BFF
 * [POS]: dashboard settings client for CLI agent credential authorization
 * [PROTOCOL]: update header on changes
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Hash,
  Loader2,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react";

const DAEMON_PROVISION_SCOPE = "daemon_agents:provision";

const EXPIRATION_OPTIONS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
];

const USAGE_LIMIT_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: 1, label: "Single use" },
  { value: 5, label: "5 uses" },
  { value: null, label: "No limit" },
];

const SCOPE_COPY: Record<string, { label: string; description: string }> = {
  "cloud_agents:create": {
    label: "Create cloud bots",
    description: "Allows this CLI credential to create cloud-hosted BotCord agents.",
  },
  "team_orchestration:provision": {
    label: "Provision teams",
    description: "Allows this CLI credential to create team-orchestration agents and runs.",
  },
  [DAEMON_PROVISION_SCOPE]: {
    label: "Provision daemon bots",
    description: "Allows this CLI credential to create bots on one specific daemon.",
  },
  "runtime_skills:install": {
    label: "Install runtime skills",
    description: "Allows this CLI credential to install skills during provisioning.",
  },
};

interface AgentManagementGrant {
  id: string;
  agent_id: string;
  scope: string;
  daemon_instance_id: string | null;
  limits: Record<string, unknown>;
  use_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
}

interface GrantListResponse {
  grants: AgentManagementGrant[];
}

function parseScopes(scopeParams: string[]): string[] {
  return Array.from(
    new Set(
      scopeParams
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function scopeLabel(scope: string): string {
  return SCOPE_COPY[scope]?.label ?? scope;
}

function scopeDescription(scope: string): string {
  return SCOPE_COPY[scope]?.description ?? "Allows the requested management action.";
}

function formatDate(value: string | null): string {
  if (!value) return "No expiration";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function isCurrentGrant(grant: AgentManagementGrant): boolean {
  if (grant.revoked_at) return false;
  const maxUses = grant.limits.max_uses;
  if (
    typeof maxUses === "number" &&
    Number.isInteger(maxUses) &&
    maxUses >= 0 &&
    grant.use_count >= maxUses
  ) {
    return false;
  }
  if (!grant.expires_at) return true;
  const expiresAt = new Date(grant.expires_at).getTime();
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) return false;
  return true;
}

function mergeGrants(
  next: AgentManagementGrant[],
  previous: AgentManagementGrant[],
): AgentManagementGrant[] {
  const grantsById = new Map<string, AgentManagementGrant>();
  for (const grant of next) {
    grantsById.set(grant.id, grant);
  }
  for (const grant of previous) {
    if (!grantsById.has(grant.id)) {
      grantsById.set(grant.id, grant);
    }
  }
  return Array.from(grantsById.values());
}

function usageLimitLabel(value: number | null): string {
  return USAGE_LIMIT_OPTIONS.find((option) => option.value === value)?.label ?? `${value} uses`;
}

async function apiErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return res.statusText || `HTTP ${res.status}`;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data.error === "string") return data.error;
    if (typeof data.message === "string") return data.message;
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) {
      return data.detail
        .map((item) => {
          if (item && typeof item === "object" && "msg" in item) {
            return String((item as { msg: unknown }).msg);
          }
          return JSON.stringify(item);
        })
        .join("; ");
    }
    if (data.detail && typeof data.detail === "object") {
      const detail = data.detail as Record<string, unknown>;
      if (typeof detail.message === "string") return detail.message;
      if (typeof detail.code === "string") return detail.code;
    }
  } catch {
    return text;
  }
  return res.statusText || `HTTP ${res.status}`;
}

async function fetchGrants(agentId: string): Promise<AgentManagementGrant[]> {
  const params = new URLSearchParams({ agent_id: agentId });
  const res = await fetch(`/api/agent-management/grants?${params.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  const data = (await res.json()) as GrantListResponse;
  return data.grants ?? [];
}

async function createGrants(body: {
  agent_id: string;
  scopes: string[];
  expires_in_days: number;
  daemon_instance_id?: string;
  limits?: Record<string, unknown>;
}): Promise<AgentManagementGrant[]> {
  const res = await fetch("/api/agent-management/grants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  const data = (await res.json()) as GrantListResponse;
  return data.grants ?? [];
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "error" | "warning" | "success";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const classes =
    tone === "success"
      ? "border-neon-green/25 bg-neon-green/10 text-neon-green"
      : tone === "warning"
        ? "border-yellow-400/25 bg-yellow-400/10 text-yellow-200"
        : "border-red-400/25 bg-red-400/10 text-red-300";
  return (
    <div className={`mb-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${classes}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ScopeList({
  scopes,
  activeScopes,
  daemonInstanceId,
}: {
  scopes: string[];
  activeScopes?: Set<string>;
  daemonInstanceId: string | null;
}) {
  return (
    <div className="space-y-2">
      {scopes.map((scope) => {
        const active = activeScopes?.has(scope) ?? false;
        const isDaemonScope = scope === DAEMON_PROVISION_SCOPE;
        return (
          <div
            key={scope}
            className="rounded-lg border border-glass-border bg-deep-black/30 px-3 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text-primary">
                {scopeLabel(scope)}
              </span>
              <span className="rounded border border-glass-border bg-glass-bg px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                {scope}
              </span>
              {active ? (
                <span className="rounded-full bg-neon-green/10 px-2 py-0.5 text-[11px] text-neon-green">
                  Active
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {scopeDescription(scope)}
            </p>
            {isDaemonScope && daemonInstanceId ? (
              <p className="mt-2 font-mono text-[11px] text-text-tertiary">
                daemon_instance_id: {daemonInstanceId}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function CliPermissionsClient({
  agentId,
  scopeParams,
  daemonInstanceId,
}: {
  agentId: string;
  scopeParams: string[];
  daemonInstanceId: string | null;
}) {
  const requestedScopes = useMemo(() => parseScopes(scopeParams), [scopeParams]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [maxUses, setMaxUses] = useState<number | null>(1);
  const [loading, setLoading] = useState(true);
  const [existingGrants, setExistingGrants] = useState<AgentManagementGrant[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createdGrants, setCreatedGrants] = useState<AgentManagementGrant[] | null>(null);

  const hasScopes = requestedScopes.length > 0;
  const needsDaemonId =
    requestedScopes.includes(DAEMON_PROVISION_SCOPE) && !daemonInstanceId;

  const activeScopes = useMemo(() => {
    const active = new Set<string>();
    for (const grant of existingGrants) {
      if (!requestedScopes.includes(grant.scope) || !isCurrentGrant(grant)) {
        continue;
      }
      if (grant.scope === DAEMON_PROVISION_SCOPE) {
        if (daemonInstanceId && grant.daemon_instance_id === daemonInstanceId) {
          active.add(grant.scope);
        }
        continue;
      }
      if (grant.daemon_instance_id === null) {
        active.add(grant.scope);
      }
    }
    return active;
  }, [daemonInstanceId, existingGrants, requestedScopes]);

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setExistingGrants(await fetchGrants(agentId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = useCallback(async () => {
    if (!hasScopes || needsDaemonId || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setCreatedGrants(null);
    try {
      const limits = maxUses === null ? undefined : { max_uses: maxUses };
      const globalScopes = requestedScopes.filter(
        (scope) => scope !== DAEMON_PROVISION_SCOPE,
      );
      const daemonScopes = requestedScopes.filter(
        (scope) => scope === DAEMON_PROVISION_SCOPE,
      );
      const grants: AgentManagementGrant[] = [];

      if (globalScopes.length > 0) {
        grants.push(
          ...(await createGrants({
            agent_id: agentId,
            scopes: globalScopes,
            expires_in_days: expiresInDays,
            limits,
          })),
        );
      }

      if (daemonScopes.length > 0 && daemonInstanceId) {
        grants.push(
          ...(await createGrants({
            agent_id: agentId,
            scopes: daemonScopes,
            expires_in_days: expiresInDays,
            daemon_instance_id: daemonInstanceId,
            limits,
          })),
        );
      }

      setCreatedGrants(grants);
      setExistingGrants((prev) => mergeGrants(grants, prev));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    agentId,
    daemonInstanceId,
    expiresInDays,
    hasScopes,
    maxUses,
    needsDaemonId,
    requestedScopes,
    submitting,
  ]);

  return (
    <div className="max-w-3xl">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-neon-cyan" />
          <div>
            <h1 className="text-lg font-semibold text-text-primary">
              CLI management permission
            </h1>
            <p className="mt-1 text-xs text-text-secondary">
              Approve a BotCord CLI credential to perform selected management actions.
            </p>
          </div>
        </div>
        <Link
          href="/chats/messages"
          className="rounded-lg border border-glass-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
        >
          Dashboard
        </Link>
      </header>

      <section className="mb-4 rounded-lg border border-glass-border bg-glass-bg/40 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-normal text-text-secondary">
              Agent
            </div>
            <div className="mt-1 font-mono text-sm text-text-primary">{agentId}</div>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking existing grants
            </div>
          ) : null}
        </div>

        {!hasScopes ? (
          <Notice tone="error" icon={<XCircle className="h-4 w-4" />}>
            This authorization link did not include any requested scopes. Return to
            the CLI and retry the command that generated it.
          </Notice>
        ) : null}

        {needsDaemonId ? (
          <Notice tone="warning" icon={<AlertTriangle className="h-4 w-4" />}>
            <div className="font-medium">Daemon-specific approval required</div>
            <div className="mt-1 text-yellow-100/80">
              The requested scope includes <span className="font-mono">{DAEMON_PROVISION_SCOPE}</span>,
              but this link has no <span className="font-mono">daemon_instance_id</span>.
              No global daemon grant will be created.
            </div>
          </Notice>
        ) : null}

        {loadError ? (
          <Notice tone="error" icon={<XCircle className="h-4 w-4" />}>
            Could not load existing grants: {loadError}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-3 rounded border border-red-400/40 px-2 py-0.5 text-xs text-red-200 hover:bg-red-400/10"
            >
              Retry
            </button>
          </Notice>
        ) : null}

        {hasScopes ? (
          <>
            <div className="mb-2 text-xs font-medium uppercase tracking-normal text-text-secondary">
              Requested scopes
            </div>
            <ScopeList
              scopes={requestedScopes}
              activeScopes={activeScopes}
              daemonInstanceId={daemonInstanceId}
            />
          </>
        ) : null}
      </section>

      {createdGrants ? (
        <section className="mb-4 rounded-lg border border-neon-green/25 bg-neon-green/10 p-5">
          <div className="mb-3 flex items-center gap-2 text-neon-green">
            <CheckCircle2 className="h-5 w-5" />
            <h2 className="text-sm font-semibold">Permission approved</h2>
          </div>
          <ScopeList
            scopes={createdGrants.map((grant) => grant.scope)}
            activeScopes={new Set(createdGrants.map((grant) => grant.scope))}
            daemonInstanceId={daemonInstanceId}
          />
          <div className="mt-3 space-y-1 text-xs text-neon-green/80">
            {createdGrants.map((grant) => (
              <div key={grant.id}>
                {scopeLabel(grant.scope)} expires {formatDate(grant.expires_at)}
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-neon-green/20 bg-deep-black/30 px-3 py-3 text-sm text-neon-green">
            <div className="mb-1 flex items-center gap-2 font-medium">
              <Terminal className="h-4 w-4" />
              Return to CLI
            </div>
            <p className="text-xs text-neon-green/80">
              Re-run the command that printed this authorization link.
            </p>
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-glass-border bg-glass-bg/40 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-text-secondary" />
            <div>
              <h2 className="text-sm font-semibold text-text-primary">
                Expiration
              </h2>
              <p className="text-xs text-text-secondary">
                The CLI credential can use these permissions until the grant expires.
              </p>
            </div>
          </div>

          <div className="mb-5 inline-flex rounded-lg border border-glass-border bg-deep-black/30 p-1">
            {EXPIRATION_OPTIONS.map((option) => {
              const active = expiresInDays === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setExpiresInDays(option.value)}
                  disabled={submitting}
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                    active
                      ? "bg-neon-cyan/15 text-neon-cyan"
                      : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="mb-4 flex items-center gap-2">
            <Hash className="h-4 w-4 text-text-secondary" />
            <div>
              <h2 className="text-sm font-semibold text-text-primary">
                Usage limit
              </h2>
              <p className="text-xs text-text-secondary">
                The grant is consumed after successful management calls from this CLI credential.
              </p>
            </div>
          </div>

          <div className="mb-5 inline-flex rounded-lg border border-glass-border bg-deep-black/30 p-1">
            {USAGE_LIMIT_OPTIONS.map((option) => {
              const active = maxUses === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => setMaxUses(option.value)}
                  disabled={submitting}
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                    active
                      ? "bg-neon-cyan/15 text-neon-cyan"
                      : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {submitError ? (
            <Notice tone="error" icon={<XCircle className="h-4 w-4" />}>
              Approval failed: {submitError}
            </Notice>
          ) : null}

          {activeScopes.size === requestedScopes.length && requestedScopes.length > 0 ? (
            <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />}>
              All requested scopes already have active grants. Approving again extends
              their expiration.
            </Notice>
          ) : null}

          <button
            type="button"
            onClick={() => void approve()}
            disabled={!hasScopes || needsDaemonId || submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-neon-cyan px-4 py-2 text-sm font-semibold text-deep-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Approve
          </button>
          <span className="ml-3 align-middle text-xs text-text-secondary">
            {usageLimitLabel(maxUses)}
          </span>
        </section>
      )}
    </div>
  );
}
