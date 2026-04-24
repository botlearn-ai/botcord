"use client";

/**
 * [INPUT]: useDaemonStore for daemon/runtime discovery + provision_agent dispatch; i18n createAgentDialog
 * [OUTPUT]: CreateAgentDialog — picks a daemon + runtime, provisions a new agent on that daemon
 * [POS]: opened from AccountMenu "Create Agent" action; success refreshes the agent list
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCcw,
  Server,
  X,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { createAgentDialog } from "@/lib/i18n/translations/dashboard";
import {
  useDaemonStore,
  ProvisionAgentError,
  type DaemonInstance,
  type DaemonRuntime,
} from "@/store/useDaemonStore";

interface CreateAgentDialogProps {
  onClose: () => void;
  onSuccess: (agentId: string) => Promise<void> | void;
}

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://api.botcord.chat");

function buildStartCommand(): string {
  return `npx -y -p @botcord/daemon@latest botcord-daemon start --hub ${HUB_BASE_URL}`;
}

function firstOnline(daemons: DaemonInstance[]): DaemonInstance | null {
  return daemons.find((d) => d.status === "online") ?? null;
}

export default function CreateAgentDialog({
  onClose,
  onSuccess,
}: CreateAgentDialogProps) {
  const locale = useLanguage();
  const t = createAgentDialog[locale];

  const daemons = useDaemonStore((s) => s.daemons);
  const loading = useDaemonStore((s) => s.loading);
  const loaded = useDaemonStore((s) => s.loaded);
  const refresh = useDaemonStore((s) => s.refresh);
  const refreshingRuntimesId = useDaemonStore((s) => s.refreshingRuntimesId);
  const refreshRuntimes = useDaemonStore((s) => s.refreshRuntimes);
  const provisionAgent = useDaemonStore((s) => s.provisionAgent);

  const onlineDaemons = useMemo(
    () => daemons.filter((d) => d.status === "online"),
    [daemons],
  );

  const [selectedDaemonId, setSelectedDaemonId] = useState<string | null>(null);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  // Auto-select first online daemon once the list arrives.
  useEffect(() => {
    if (selectedDaemonId) {
      const stillOnline = onlineDaemons.some((d) => d.id === selectedDaemonId);
      if (stillOnline) return;
    }
    const pick = firstOnline(daemons);
    setSelectedDaemonId(pick?.id ?? null);
  }, [daemons, onlineDaemons, selectedDaemonId]);

  const selectedDaemon = useMemo(
    () => daemons.find((d) => d.id === selectedDaemonId) ?? null,
    [daemons, selectedDaemonId],
  );

  // Auto-select first available runtime when daemon changes.
  useEffect(() => {
    if (!selectedDaemon) {
      setSelectedRuntimeId(null);
      return;
    }
    const runtimes = selectedDaemon.runtimes ?? [];
    const stillValid =
      selectedRuntimeId &&
      runtimes.some((r) => r.id === selectedRuntimeId && r.available);
    if (stillValid) return;
    const firstAvailable = runtimes.find((r) => r.available);
    setSelectedRuntimeId(firstAvailable?.id ?? null);
  }, [selectedDaemon, selectedRuntimeId]);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildStartCommand());
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch {
      // ignore — user can select-and-copy manually
    }
  }

  function translateError(err: unknown): string {
    if (err instanceof ProvisionAgentError) {
      switch (err.code) {
        case "daemon_offline":
          return t.errorDaemonOffline;
        case "daemon_timeout":
          return t.errorDaemonTimeout;
        case "daemon_failed":
          return err.detail
            ? `${t.errorDaemonFailed}: ${err.detail}`
            : t.errorDaemonFailed;
        case "missing_agent_id":
          return t.errorMissingAgentId;
        case "http_error":
          return err.detail || t.errorGeneric;
      }
    }
    return err instanceof Error ? err.message : t.errorGeneric;
  }

  async function handleSubmit(): Promise<void> {
    if (!selectedDaemonId || !selectedRuntimeId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await provisionAgent(selectedDaemonId, {
        name: name.trim() || undefined,
        bio: bio.trim() || undefined,
        runtime: selectedRuntimeId,
      });
      await onSuccess(res.agentId);
      onClose();
    } catch (err) {
      setError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const showEmptyState = loaded && onlineDaemons.length === 0;
  const canSubmit =
    !!selectedDaemonId && !!selectedRuntimeId && !submitting;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <button
          onClick={onClose}
          disabled={submitting}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-5 pr-8">
          <h3 className="flex items-center gap-2 text-xl font-bold text-text-primary">
            <Bot className="h-5 w-5 text-neon-cyan" />
            {t.title}
          </h3>
          <p className="mt-2 text-sm text-text-secondary">{t.description}</p>
        </div>

        {!loaded && loading ? (
          <div className="flex items-center justify-center py-10 text-text-secondary">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : showEmptyState ? (
          <NoDaemonState
            command={buildStartCommand()}
            copied={copied}
            onCopy={handleCopy}
            loading={loading}
            onRefresh={() => void refresh()}
            labels={{
              title: t.noDaemonTitle,
              hint: t.noDaemonHint,
              commandHint: t.commandHint,
              copy: t.copy,
              copied: t.copied,
              openActivate: t.openActivate,
              refresh: t.refreshDaemons,
            }}
          />
        ) : (
          <div className="space-y-4">
            {onlineDaemons.length > 1 && (
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  {t.daemonLabel}
                </label>
                <select
                  value={selectedDaemonId ?? ""}
                  onChange={(e) => setSelectedDaemonId(e.target.value)}
                  disabled={submitting}
                  className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
                >
                  {onlineDaemons.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label || d.id}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {onlineDaemons.length === 1 && selectedDaemon && (
              <div className="flex items-center gap-2 rounded-xl border border-glass-border bg-glass-bg/40 px-3 py-2 text-xs text-text-secondary">
                <Server className="h-3.5 w-3.5 text-neon-cyan" />
                <span className="text-text-primary">
                  {selectedDaemon.label || selectedDaemon.id}
                </span>
                <span className="ml-auto inline-flex h-1.5 w-1.5 rounded-full bg-neon-green" />
              </div>
            )}

            <RuntimePicker
              daemon={selectedDaemon}
              selectedRuntimeId={selectedRuntimeId}
              onSelect={setSelectedRuntimeId}
              refreshing={
                !!selectedDaemon &&
                refreshingRuntimesId === selectedDaemon.id
              }
              onRefresh={() => {
                if (selectedDaemon) void refreshRuntimes(selectedDaemon.id);
              }}
              labels={{
                runtimeLabel: t.runtimeLabel,
                noRuntimesDetected: t.noRuntimesDetected,
                probeRuntimes: t.probeRuntimes,
                unavailable: t.runtimeUnavailable,
              }}
              disabled={submitting}
            />

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
                {t.nameLabel}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.namePlaceholder}
                disabled={submitting}
                className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
                maxLength={64}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
                {t.bioLabel}
              </label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder={t.bioPlaceholder}
                disabled={submitting}
                rows={2}
                className="w-full resize-none rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
                maxLength={240}
              />
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
            {error}
          </p>
        )}

        {!showEmptyState && loaded && (
          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
            >
              {t.cancel}
            </button>
            <button
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="flex items-center gap-2 rounded-xl border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2.5 text-sm font-bold text-neon-cyan transition-all hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t.submitting}
                </>
              ) : (
                t.submit
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NoDaemonState({
  command,
  copied,
  onCopy,
  loading,
  onRefresh,
  labels,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void | Promise<void>;
  loading: boolean;
  onRefresh: () => void;
  labels: {
    title: string;
    hint: string;
    commandHint: string;
    copy: string;
    copied: string;
    openActivate: string;
    refresh: string;
  };
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-dashed border-glass-border bg-glass-bg/40 p-4">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-text-primary">
          <Server className="h-4 w-4 text-text-secondary" />
          {labels.title}
        </div>
        <p className="text-xs text-text-secondary">{labels.hint}</p>
      </div>

      <div>
        <p className="mb-2 text-xs text-text-secondary">{labels.commandHint}</p>
        <div className="flex items-stretch gap-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-xl border border-glass-border bg-deep-black px-3 py-2 font-mono text-xs text-text-primary">
            {command}
          </code>
          <button
            type="button"
            onClick={() => void onCopy()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-glass-border px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-neon-green" />
                {labels.copied}
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                {labels.copy}
              </>
            )}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Link
          href="/activate"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-neon-cyan hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {labels.openActivate}
        </Link>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          {labels.refresh}
        </button>
      </div>
    </div>
  );
}

function RuntimePicker({
  daemon,
  selectedRuntimeId,
  onSelect,
  refreshing,
  onRefresh,
  disabled,
  labels,
}: {
  daemon: DaemonInstance | null;
  selectedRuntimeId: string | null;
  onSelect: (id: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  disabled: boolean;
  labels: {
    runtimeLabel: string;
    noRuntimesDetected: string;
    probeRuntimes: string;
    unavailable: string;
  };
}) {
  const runtimes = daemon?.runtimes ?? [];
  const hasAny = runtimes.length > 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
          {labels.runtimeLabel}
        </label>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || disabled || !daemon}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCcw className="h-3 w-3" />
          )}
          {labels.probeRuntimes}
        </button>
      </div>

      {!hasAny ? (
        <div className="rounded-xl border border-dashed border-glass-border bg-glass-bg/40 px-3 py-4 text-center text-xs text-text-secondary">
          {labels.noRuntimesDetected}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {runtimes.map((r) => (
            <RuntimeCard
              key={r.id}
              runtime={r}
              selected={selectedRuntimeId === r.id}
              disabled={disabled || !r.available}
              onClick={() => r.available && onSelect(r.id)}
              unavailableLabel={labels.unavailable}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RuntimeCard({
  runtime,
  selected,
  disabled,
  onClick,
  unavailableLabel,
}: {
  runtime: DaemonRuntime;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  unavailableLabel: string;
}) {
  const base =
    "flex items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors";
  const state = !runtime.available
    ? "cursor-not-allowed border-glass-border bg-glass-bg/30 text-text-tertiary"
    : selected
      ? "border-neon-cyan bg-neon-cyan/10 text-text-primary"
      : "border-glass-border bg-deep-black text-text-primary hover:border-neon-cyan/50 hover:bg-glass-bg";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${state}`}
      title={runtime.path || runtime.error || runtime.id}
    >
      <span
        className={`mt-0.5 inline-block h-2 w-2 flex-shrink-0 rounded-full ${
          runtime.available ? "bg-neon-green" : "bg-zinc-500"
        }`}
      />
      <span className="flex-1 min-w-0">
        <span className="block truncate font-mono text-xs">
          {runtime.id}
          {runtime.version ? ` @ ${runtime.version}` : ""}
        </span>
        {!runtime.available && (
          <span className="mt-0.5 block truncate text-[10px] text-text-tertiary">
            {runtime.error || unavailableLabel}
          </span>
        )}
      </span>
      {selected && runtime.available && (
        <Check className="h-4 w-4 flex-shrink-0 text-neon-cyan" />
      )}
    </button>
  );
}
