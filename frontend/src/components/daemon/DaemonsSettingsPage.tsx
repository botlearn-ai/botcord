"use client";

/**
 * [INPUT]: useDaemonStore for daemon list / refresh / revoke; renders into the settings shell
 * [OUTPUT]: DaemonsSettingsPage — table of the current user's daemon_instances + revoke action
 * [POS]: dashboard /settings/daemons content
 * [PROTOCOL]: update header on changes
 */

import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import DialogShell from "@/components/ui/DialogShell";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import Table, { TableHead, TableRow, TableHeader, TableBody, TableCell } from "@/components/ui/Table";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  FileArchive,
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
import { downloadApiFile } from "@/lib/api";

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

function compactDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function truncateId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function StatusBadge({ status }: { status: DaemonInstance["status"] }) {
  const tones = { online: "success", offline: "neutral", revoked: "danger", removal_pending: "warning" } as const;
  return <Badge tone={tones[status]}>{status}</Badge>;
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
    <DialogShell title="Revoke this daemon?" role="alertdialog" size="sm" onClose={onCancel} busy={pending}
      footer={(close) => <><Button onClick={close} disabled={pending}>Cancel</Button><Button variant="danger" onClick={onConfirm} loading={pending}>Revoke</Button></>}>
      <p className="text-sm text-text-secondary">The daemon <span className="font-medium text-text-primary">{daemon.label || truncateId(daemon.id)}</span> will lose its credentials and disconnect from the control channel. You can authorize it again later from /activate.</p>
    </DialogShell>
  );
}

function RuntimeChip({ runtime }: { runtime: DaemonRuntime }) {
  const label = runtime.version
    ? `${runtime.id} @ ${runtime.version}`
    : runtime.id;
  const title = runtime.available
    ? runtime.path || label
    : runtime.error || "unavailable";
  return <Badge title={title} tone={runtime.available ? "accent" : "neutral"}>{label}</Badge>;
}

function DaemonVersionChip({ version }: { version?: string | null }) {
  const label = version || "--";
  return <Badge title="Running botcord-daemon version">daemon {label}</Badge>;
}

function RuntimesBlock({
  daemon,
  refreshing,
  errorMsg,
  onRefresh,
  collectingDiagnostics,
  diagnosticError,
  diagnosticResult,
  onCollectDiagnostics,
}: {
  daemon: DaemonInstance;
  refreshing: boolean;
  errorMsg: string | undefined;
  onRefresh: () => void;
  collectingDiagnostics: boolean;
  diagnosticError: string | undefined;
  diagnosticResult:
    | {
        bundle_id: string;
        filename: string;
        size_bytes: number;
        expires_at?: string | null;
        local_path?: string | null;
      }
    | undefined;
  onCollectDiagnostics: () => void;
}) {
  const runtimes = daemon.runtimes;
  const circuitBreakers =
    runtimes?.flatMap((runtime) =>
      (runtime.health?.circuitBreakers ?? []).map((breaker) => ({
        runtimeId: runtime.id,
        ...breaker,
      })),
    ) ?? [];
  const disabled = refreshing || daemon.status === "revoked";
  const diagnosticsDisabled =
    collectingDiagnostics || daemon.status !== "online";
  return (
    <Card padding="sm" className="mt-2 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
            Runtimes
          </span>
          {daemon.runtimes_probed_at ? (
            <span className="text-xs text-text-secondary">
              Last probed {relativeTime(daemon.runtimes_probed_at)}
            </span>
          ) : null}
        </div>
        <DaemonVersionChip version={daemon.daemon_version} />
        <Button variant="secondary" size="sm"
          type="button"
          onClick={onRefresh}
          disabled={disabled} >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCcw className="h-3 w-3" />
          )}
          Refresh runtimes
        </Button>
      </div>

      {runtimes === null || runtimes === undefined ? (
        <span className="text-xs text-text-secondary">
          No runtime data yet (runs once per daemon connect)
        </span>
      ) : runtimes.length === 0 ? (
        <span className="text-xs text-text-secondary">
          No runtimes detected
        </span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {runtimes.map((r) => (
            <RuntimeChip key={r.id} runtime={r} />
          ))}
        </div>
      )}

      {circuitBreakers.length > 0 ? (
        <Alert tone="warning" >
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3" />
            Runtime dispatch paused
          </div>
          <div className="mt-0.5 text-warning">
            {circuitBreakers.map((breaker) => {
              const until = new Date(breaker.blockedUntil);
              const untilText = Number.isNaN(until.getTime())
                ? "temporarily"
                : `until ${until.toLocaleTimeString()}`;
              return `${breaker.runtimeId} in ${breaker.conversationId}: ${breaker.lastError || "authentication failed"} (${breaker.failures} failures, ${untilText})`;
            }).join("; ")}
          </div>
        </Alert>
      ) : null}

      {errorMsg ? (
        <Alert tone="danger" >
          {errorMsg}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-glass-border/40 pt-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
            Troubleshooting logs
          </span>
          <span className="text-xs text-text-secondary">
            Recent device logs for support.
          </span>
        </div>
        <Button variant="secondary" size="sm"
          type="button"
          onClick={onCollectDiagnostics}
          disabled={diagnosticsDisabled}
          title={
            daemon.status === "online"
              ? "Collect logs from this device"
              : "Device must be online to collect logs"
          } >
          {collectingDiagnostics ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <FileArchive className="h-3 w-3" />
          )}
          Collect logs
        </Button>
      </div>
      {diagnosticResult ? (
        <Alert tone="success" >
          Log file ready: {diagnosticResult.filename} ({diagnosticResult.size_bytes} bytes)
          {diagnosticResult.expires_at
            ? `, expires ${compactDateTime(diagnosticResult.expires_at)}`
            : ""}
          {" · "}
          <Button variant="ghost"
            type="button"
            onClick={() => void downloadApiFile(
              `/daemon/diagnostics/${encodeURIComponent(diagnosticResult.bundle_id)}/download`,
              diagnosticResult.filename,
            )} >
            Download
          </Button>
        </Alert>
      ) : null}
      {diagnosticError ? (
        <Alert tone="danger" >
          {diagnosticError}
        </Alert>
      ) : null}
    </Card>
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
            <span className="text-text-secondary">unnamed</span>
          )}
        </span>
        {canEdit && (
          <IconButton label="Rename"
            type="button"
            onClick={onStartEdit}
            title="Rename" >
            <Pencil className="h-3 w-3" />
          </IconButton>
        )}
        {errorMsg ? (
          <Alert tone="danger" >{errorMsg}</Alert>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
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
        aria-label="Daemon label"
        placeholder="Label (optional)"
      />
      <IconButton label="Save"
        type="button"
        onClick={() => onSubmit(draft)}
        disabled={pending}
        title="Save" >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
      </IconButton>
      <IconButton label="Cancel"
        type="button"
        onClick={onCancel}
        disabled={pending}
        title="Cancel" >
        <X className="h-3.5 w-3.5" />
      </IconButton>
      {errorMsg ? (
        <Alert tone="danger" >{errorMsg}</Alert>
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
  const restartingId = useDaemonStore((s) => s.restartingId);
  const renamingId = useDaemonStore((s) => s.renamingId);
  const renameErrors = useDaemonStore((s) => s.renameErrors);
  const refreshingRuntimesId = useDaemonStore((s) => s.refreshingRuntimesId);
  const collectingDiagnosticsId = useDaemonStore((s) => s.collectingDiagnosticsId);
  const runtimeErrors = useDaemonStore((s) => s.runtimeErrors);
  const diagnosticErrors = useDaemonStore((s) => s.diagnosticErrors);
  const diagnosticResults = useDaemonStore((s) => s.diagnosticResults);
  const refresh = useDaemonStore((s) => s.refresh);
  const revoke = useDaemonStore((s) => s.revoke);
  const restartDevice = useDaemonStore((s) => s.restartDevice);
  const rename = useDaemonStore((s) => s.rename);
  const refreshRuntimes = useDaemonStore((s) => s.refreshRuntimes);
  const collectDiagnostics = useDaemonStore((s) => s.collectDiagnostics);

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
          <h2 className="text-xl font-semibold text-text-primary">Daemons</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Machines authorized to act as your local BotCord agent host.
          </p>
        </div>
        <Button variant="secondary"
          type="button"
          onClick={() => void refresh()}
          disabled={loading} >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCcw className="h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {error && (
        <Alert tone="danger" >
          {error}
        </Alert>
      )}

      {showInstallPanel && (
        <DaemonInstallCommand
          labels={installLabels}
          busy={loading}
          onRefresh={() => void refresh()}
        />
      )}

      {empty ? null : (
        <div className="min-w-0">
          <Table aria-label="Daemons" >
            <TableHead>
              <TableRow>
                <TableHeader>Label</TableHeader>
                <TableHeader>Daemon</TableHeader>
                <TableHeader>Last seen</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader className="text-right">Actions</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {!loaded && loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((d) => (
                  <Fragment key={d.id}>
                    <TableRow>
                      <TableCell>
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
                      </TableCell>
                      <TableCell>
                        <DaemonVersionChip version={d.daemon_version} />
                      </TableCell>
                      <TableCell>
                        {relativeTime(d.last_seen_at)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={d.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {d.status !== "revoked" && (
                          <div className="flex justify-end gap-3">
                            <Button variant="ghost" size="sm"
                              type="button"
                              onClick={() => void restartDevice(d.id)}
                              disabled={
                                restartingId === d.id ||
                                (d.kind !== "cloud" && d.status !== "online")
                              }
                              title={
                                d.status === "online" || d.kind === "cloud"
                                  ? "Pull latest daemon and reconnect"
                                  : "Daemon must be online to restart remotely"
                              } >
                              {restartingId === d.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCcw className="h-3.5 w-3.5" />
                              )}
                              Restart
                            </Button>
                            <Button variant="danger" size="sm"
                              type="button"
                              onClick={() => setConfirmTarget(d)}
                              disabled={revokingId === d.id} >
                              <XCircle className="h-3.5 w-3.5" />
                              Revoke
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={5} >
                        <RuntimesBlock
                          daemon={d}
                          refreshing={refreshingRuntimesId === d.id}
                          errorMsg={runtimeErrors[d.id]}
                          onRefresh={() => void refreshRuntimes(d.id)}
                          collectingDiagnostics={collectingDiagnosticsId === d.id}
                          diagnosticError={diagnosticErrors[d.id]}
                          diagnosticResult={diagnosticResults[d.id]}
                          onCollectDiagnostics={() => void collectDiagnostics(d.id)}
                        />
                      </TableCell>
                    </TableRow>
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
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
