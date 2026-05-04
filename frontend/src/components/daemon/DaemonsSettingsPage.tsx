"use client";

/**
 * [INPUT]: useDaemonStore for daemon list / refresh / revoke; renders into the settings shell
 * [OUTPUT]: DaemonsSettingsPage — table of the current user's daemon_instances + revoke action
 * [POS]: dashboard /settings/daemons content
 * [PROTOCOL]: update header on changes
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Pencil,
  RefreshCcw,
  X,
  XCircle,
} from "lucide-react";
import {
  useDaemonStore,
  type DaemonInstance,
  type DaemonRuntime,
} from "@/store/useDaemonStore";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 30_000) return "just now";
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function truncateId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function StatusBadge({ status }: { status: DaemonInstance["status"] }) {
  const map: Record<DaemonInstance["status"], string> = {
    online: "bg-neon-green/10 text-neon-green",
    offline: "bg-glass-bg text-text-secondary",
    revoked: "bg-red-400/10 text-red-300",
    removal_pending: "bg-yellow-400/10 text-yellow-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${map[status]}`}
    >
      {status}
    </span>
  );
}

function ConfirmDialog({
  daemon,
  onCancel,
  onConfirm,
  pending,
}: {
  daemon: DaemonInstance;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur">
      <div className="w-full max-w-sm rounded-2xl border border-glass-border bg-deep-black-light p-6 shadow-2xl">
        <div className="mb-3 flex items-center gap-2 text-red-300">
          <AlertTriangle className="h-5 w-5" />
          <h3 className="text-sm font-semibold">Revoke this daemon?</h3>
        </div>
        <p className="mb-5 text-sm text-text-secondary">
          The daemon{" "}
          <span className="font-medium text-text-primary">
            {daemon.label || truncateId(daemon.id)}
          </span>{" "}
          will lose its credentials and disconnect from the control channel. You
          can authorize it again later from /activate.
        </p>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-xl border border-glass-border px-4 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-xl bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Revoke
          </button>
        </div>
      </div>
    </div>
  );
}

function RuntimeChip({ runtime }: { runtime: DaemonRuntime }) {
  const label = runtime.version
    ? `${runtime.id} @ ${runtime.version}`
    : runtime.id;
  const title = runtime.available
    ? runtime.path || label
    : runtime.error || "unavailable";
  const cls = runtime.available
    ? "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan"
    : "border-glass-border bg-glass-bg text-text-tertiary";
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] ${cls}`}
    >
      {label}
    </span>
  );
}

function RuntimesBlock({
  daemon,
  refreshing,
  errorMsg,
  onRefresh,
}: {
  daemon: DaemonInstance;
  refreshing: boolean;
  errorMsg: string | undefined;
  onRefresh: () => void;
}) {
  const runtimes = daemon.runtimes;
  const disabled = refreshing || daemon.status === "revoked";
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-glass-border/60 bg-glass-bg/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Runtimes
          </span>
          {daemon.runtimes_probed_at ? (
            <span className="text-[11px] text-text-tertiary">
              Last probed {relativeTime(daemon.runtimes_probed_at)}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-lg border border-glass-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCcw className="h-3 w-3" />
          )}
          Refresh runtimes
        </button>
      </div>

      {runtimes === null || runtimes === undefined ? (
        <span className="text-[11px] text-text-tertiary">
          No runtime data yet (runs once per daemon connect)
        </span>
      ) : runtimes.length === 0 ? (
        <span className="text-[11px] text-text-tertiary">
          No runtimes detected
        </span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {runtimes.map((r) => (
            <RuntimeChip key={r.id} runtime={r} />
          ))}
        </div>
      )}

      {errorMsg ? (
        <span className="rounded-md border border-red-400/20 bg-red-400/10 px-2 py-1 text-[11px] text-red-300">
          {errorMsg}
        </span>
      ) : null}
    </div>
  );
}

function LabelCell({
  daemon,
  editing,
  pending,
  errorMsg,
  onStartEdit,
  onSubmit,
  onCancel,
}: {
  daemon: DaemonInstance;
  editing: boolean;
  pending: boolean;
  errorMsg: string | undefined;
  onStartEdit: () => void;
  onSubmit: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(daemon.label ?? "");

  useEffect(() => {
    if (editing) setDraft(daemon.label ?? "");
  }, [editing, daemon.label]);

  if (!editing) {
    const canEdit = daemon.status !== "revoked";
    return (
      <div className="flex items-center gap-2">
        <span className="text-text-primary">
          {daemon.label || (
            <span className="text-text-tertiary">unnamed</span>
          )}
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={onStartEdit}
            className="rounded p-1 text-text-tertiary transition-colors hover:bg-glass-bg hover:text-text-primary"
            title="Rename"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {errorMsg ? (
          <span className="text-[11px] text-red-300">{errorMsg}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={draft}
        autoFocus
        maxLength={64}
        disabled={pending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(draft);
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Label (optional)"
        className="w-40 rounded-md border border-glass-border bg-deep-black-light px-2 py-1 text-sm text-text-primary outline-none focus:border-neon-cyan/50 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => onSubmit(draft)}
        disabled={pending}
        className="rounded p-1 text-neon-green transition-colors hover:bg-glass-bg disabled:opacity-50"
        title="Save"
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        className="rounded p-1 text-text-tertiary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        title="Cancel"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {errorMsg ? (
        <span className="text-[11px] text-red-300">{errorMsg}</span>
      ) : null}
    </div>
  );
}

export default function DaemonsSettingsPage() {
  const daemons = useDaemonStore((s) => s.daemons);
  const loading = useDaemonStore((s) => s.loading);
  const loaded = useDaemonStore((s) => s.loaded);
  const error = useDaemonStore((s) => s.error);
  const revokingId = useDaemonStore((s) => s.revokingId);
  const renamingId = useDaemonStore((s) => s.renamingId);
  const renameErrors = useDaemonStore((s) => s.renameErrors);
  const refreshingRuntimesId = useDaemonStore((s) => s.refreshingRuntimesId);
  const runtimeErrors = useDaemonStore((s) => s.runtimeErrors);
  const refresh = useDaemonStore((s) => s.refresh);
  const revoke = useDaemonStore((s) => s.revoke);
  const rename = useDaemonStore((s) => s.rename);
  const refreshRuntimes = useDaemonStore((s) => s.refreshRuntimes);

  const [confirmTarget, setConfirmTarget] = useState<DaemonInstance | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(() => {
    return [...daemons].sort((a, b) => {
      const order: Record<DaemonInstance["status"], number> = {
        online: 0,
        offline: 1,
        removal_pending: 2,
        revoked: 3,
      };
      const oa = order[a.status] ?? 3;
      const ob = order[b.status] ?? 3;
      if (oa !== ob) return oa - ob;
      const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
      const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
      return tb - ta;
    });
  }, [daemons]);

  const empty = loaded && sorted.length === 0;
  const hasOffline = sorted.some((d) => d.status === "offline");
  const showInstallPanel = empty || hasOffline;

  // Auto-detect daemons coming online while the install/reconnect banner is up.
  useEffect(() => {
    if (!showInstallPanel) return;
    const id = window.setInterval(() => {
      void refresh({ quiet: true });
    }, 3_000);
    return () => window.clearInterval(id);
  }, [showInstallPanel, refresh]);

  const installLabels = empty
    ? {
        title: "No daemons connected yet",
        hint: "Run this command on the machine you want to authorize. Once it connects, it will show up here automatically.",
        copy: "Copy",
        copied: "Copied",
        openActivate: "Open activation page",
        refresh: "Refresh",
      }
    : {
        title: "Reconnect or install a daemon",
        hint: "Daemon offline? Run this command on the machine to reinstall and reconnect. Same machine reuses its credentials; new machines are authorized automatically.",
        copy: "Copy",
        copied: "Copied",
        openActivate: "Open activation page",
        refresh: "Refresh",
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-text-primary">Daemons</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Machines authorized to act as your local BotCord agent host.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-glass-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCcw className="h-4 w-4" />
          )}
          Refresh
        </button>
      </div>

      {error && (
        <p className="rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {showInstallPanel && (
        <DaemonInstallCommand
          labels={installLabels}
          busy={loading}
          onRefresh={() => void refresh()}
        />
      )}

      {empty ? null : (
        <div className="overflow-x-auto rounded-2xl border border-glass-border">
          <table className="w-full text-sm">
            <thead className="border-b border-glass-border bg-glass-bg">
              <tr>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">Label</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">ID</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">Last seen</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">Status</th>
                <th className="px-4 py-3 text-right text-xs text-text-secondary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-text-secondary">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </td>
                </tr>
              ) : (
                sorted.map((d) => (
                  <Fragment key={d.id}>
                    <tr className="border-b border-glass-border/30">
                      <td className="px-4 pt-3">
                        <LabelCell
                          daemon={d}
                          editing={editingId === d.id}
                          pending={renamingId === d.id}
                          errorMsg={renameErrors[d.id]}
                          onStartEdit={() => setEditingId(d.id)}
                          onSubmit={async (next) => {
                            const ok = await rename(d.id, next);
                            if (ok) setEditingId(null);
                          }}
                          onCancel={() => setEditingId(null)}
                        />
                      </td>
                      <td className="px-4 pt-3 font-mono text-xs text-text-secondary" title={d.id}>
                        {truncateId(d.id)}
                      </td>
                      <td className="px-4 pt-3 text-xs text-text-secondary">
                        {relativeTime(d.last_seen_at)}
                      </td>
                      <td className="px-4 pt-3">
                        <StatusBadge status={d.status} />
                      </td>
                      <td className="px-4 pt-3 text-right">
                        {d.status !== "revoked" && (
                          <button
                            type="button"
                            onClick={() => setConfirmTarget(d)}
                            disabled={revokingId === d.id}
                            className="inline-flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-red-300 disabled:opacity-50"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                    <tr className="border-b border-glass-border/50 last:border-0">
                      <td colSpan={5} className="px-4 pb-3">
                        <RuntimesBlock
                          daemon={d}
                          refreshing={refreshingRuntimesId === d.id}
                          errorMsg={runtimeErrors[d.id]}
                          onRefresh={() => void refreshRuntimes(d.id)}
                        />
                      </td>
                    </tr>
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {confirmTarget && (
        <ConfirmDialog
          daemon={confirmTarget}
          onCancel={() => setConfirmTarget(null)}
          pending={revokingId === confirmTarget.id}
          onConfirm={async () => {
            const target = confirmTarget;
            await revoke(target.id);
            setConfirmTarget(null);
          }}
        />
      )}
    </div>
  );
}
