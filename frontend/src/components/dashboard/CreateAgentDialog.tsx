"use client";

/**
 * [INPUT]: useDaemonStore for daemon/runtime discovery + provision_agent dispatch; i18n createAgentDialog
 * [OUTPUT]: CreateAgentDialog — picks a daemon + runtime, provisions a new agent on that daemon
 * [POS]: opened from AccountMenu "Create Agent" action; success refreshes the agent list
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  Info,
  Loader2,
  Plus,
  RefreshCcw,
  Server,
  Sparkles,
  X,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { createAgentDialog } from "@/lib/i18n/translations/dashboard";
import { pickRandomAgentIdentity } from "@/lib/random-agent-identity";
import {
  useDaemonStore,
  ProvisionAgentError,
  type DaemonInstance,
  type DaemonRuntime,
} from "@/store/useDaemonStore";
import {
  useOpenclawHostStore,
  OpenclawProvisionError,
  type OpenclawHost,
  type OpenclawInstallTicket,
} from "@/store/useOpenclawHostStore";
import InstallCommandPanel from "./InstallCommandPanel";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";

interface CreateAgentDialogProps {
  onClose: () => void;
  onSuccess: (agentId: string) => Promise<void> | void;
  preselectedDaemonId?: string | null;
}

function firstOnline(daemons: DaemonInstance[]): DaemonInstance | null {
  return daemons.find((d) => d.status === "online") ?? null;
}

const UNSUPPORTED_RUNTIME_IDS = new Set(["gemini"]);
const OPENCLAW_RUNTIME_ID = "openclaw-acp";
const QCLAW_RUNTIME_ID = "qclaw";

type DaemonRuntimeEndpoint = NonNullable<DaemonRuntime["endpoints"]>[number];

function isOpenclawFamilyRuntime(id: string | null): boolean {
  return id === OPENCLAW_RUNTIME_ID || id === QCLAW_RUNTIME_ID;
}

function daemonRuntimeId(id: string): string {
  return id === QCLAW_RUNTIME_ID ? OPENCLAW_RUNTIME_ID : id;
}

function isQclawEndpoint(endpoint: DaemonRuntimeEndpoint): boolean {
  try {
    const url = new URL(endpoint.url);
    if (url.port === "28789") return true;
  } catch {
    // Fall through to name/profile heuristics.
  }
  if (endpoint.name.toLowerCase().includes("qclaw")) return true;
  return (endpoint.agents ?? []).some((agent) => {
    const label = `${agent.id} ${agent.name ?? ""}`.toLowerCase();
    return label.includes("qclaw");
  });
}

function applyRuntimeSupport(
  runtimes: DaemonRuntime[] | null | undefined,
  notSupportedLabel: string,
): DaemonRuntime[] {
  if (!runtimes) return [];
  const out: DaemonRuntime[] = [];
  for (const runtime of runtimes) {
    const r = UNSUPPORTED_RUNTIME_IDS.has(runtime.id)
      ? { ...runtime, available: false, error: notSupportedLabel }
      : runtime;
    if (r.id !== OPENCLAW_RUNTIME_ID || !r.endpoints?.length) {
      out.push(r);
      continue;
    }

    const qclawEndpoints = r.endpoints.filter(isQclawEndpoint);
    const openclawEndpoints = r.endpoints.filter((endpoint) => !isQclawEndpoint(endpoint));
    if (qclawEndpoints.length > 0) {
      out.push({
        ...r,
        id: QCLAW_RUNTIME_ID,
        endpoints: qclawEndpoints,
      });
    }
    out.push({
      ...r,
      endpoints: openclawEndpoints,
    });
  }
  return out;
}

export default function CreateAgentDialog({
  onClose,
  onSuccess,
  preselectedDaemonId,
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
  const [selectedGateway, setSelectedGateway] = useState<string | null>(null);
  const [selectedOpenclawAgent, setSelectedOpenclawAgent] = useState<string | null>(null);
  const [selectedHermesProfile, setSelectedHermesProfile] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingDevice, setAddingDevice] = useState(false);
  const addDeviceExistingIdsRef = useRef<Set<string>>(new Set());
  const autoFilledNameRef = useRef<string | null>(null);
  const lastRandomIdxRef = useRef<number | undefined>(undefined);

  function handleRandomize(): void {
    const pick = pickRandomAgentIdentity(locale, lastRandomIdxRef.current);
    lastRandomIdxRef.current = pick.index;
    autoFilledNameRef.current = null;
    setName(pick.name);
    setBio(pick.bio);
    if (error === t.nameRequired) setError(null);
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-select first online daemon once the list arrives.
  // If a preselectedDaemonId was provided, use that instead.
  useEffect(() => {
    if (preselectedDaemonId && daemons.some((d) => d.id === preselectedDaemonId)) {
      setSelectedDaemonId(preselectedDaemonId);
      return;
    }
    if (selectedDaemonId) {
      const stillOnline = onlineDaemons.some((d) => d.id === selectedDaemonId);
      if (stillOnline) return;
    }
    const pick = firstOnline(daemons);
    setSelectedDaemonId(pick?.id ?? null);
  }, [daemons, onlineDaemons, selectedDaemonId, preselectedDaemonId]);

  const selectedDaemon = useMemo(() => {
    const d = daemons.find((d) => d.id === selectedDaemonId) ?? null;
    if (!d) return d;
    return { ...d, runtimes: applyRuntimeSupport(d.runtimes, t.runtimeNotSupported) };
  }, [daemons, selectedDaemonId, t.runtimeNotSupported]);

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

  // Reset OpenClaw selections when leaving the OpenClaw/QClaw runtime family.
  const selectedRuntime = useMemo(
    () => selectedDaemon?.runtimes?.find((r) => r.id === selectedRuntimeId) ?? null,
    [selectedDaemon, selectedRuntimeId],
  );
  const selectedOpenclawEndpoint = useMemo(
    () =>
      selectedRuntime?.endpoints?.find((e) => e.name === selectedGateway) ??
      null,
    [selectedRuntime, selectedGateway],
  );
  const selectableOpenclawAgents = useMemo(
    () =>
      (selectedOpenclawEndpoint?.agents ?? []).filter(
        (a) => !a.botcordBinding?.agentId,
      ),
    [selectedOpenclawEndpoint],
  );
  const selectedOpenclawAgentProfile = useMemo(
    () =>
      selectableOpenclawAgents.find((a) => a.id === selectedOpenclawAgent) ??
      null,
    [selectableOpenclawAgents, selectedOpenclawAgent],
  );
  useEffect(() => {
    if (!isOpenclawFamilyRuntime(selectedRuntimeId)) {
      setSelectedGateway(null);
      setSelectedOpenclawAgent(null);
      return;
    }
    const reachable = (selectedRuntime?.endpoints ?? []).filter((e) => e.reachable);
    if (selectedGateway && reachable.some((e) => e.name === selectedGateway)) return;
    setSelectedGateway(reachable[0]?.name ?? null);
    setSelectedOpenclawAgent(null);
  }, [selectedRuntime, selectedRuntimeId, selectedGateway]);

  useEffect(() => {
    if (!isOpenclawFamilyRuntime(selectedRuntimeId)) return;
    const agents = selectedOpenclawEndpoint?.agents ?? [];
    if (agents.length === 0) return;
    const stillSelectable =
      selectedOpenclawAgent &&
      selectableOpenclawAgents.some((a) => a.id === selectedOpenclawAgent);
    if (stillSelectable) return;
    setSelectedOpenclawAgent(selectableOpenclawAgents[0]?.id ?? null);
  }, [
    selectedRuntimeId,
    selectedOpenclawEndpoint,
    selectedOpenclawAgent,
    selectableOpenclawAgents,
  ]);

  useEffect(() => {
    const profileName = selectedOpenclawAgentProfile?.name?.trim();
    if (!profileName) {
      autoFilledNameRef.current = null;
      return;
    }
    setName((currentName) => {
      if (currentName.trim() && currentName !== autoFilledNameRef.current) {
        return currentName;
      }
      autoFilledNameRef.current = profileName;
      return profileName;
    });
  }, [selectedOpenclawAgentProfile?.id, selectedOpenclawAgentProfile?.name]);

  // Auto-pick the first available hermes profile when the user lands on
  // hermes-agent. Prefer the active profile, falling back to the first
  // unoccupied entry. Reset when leaving the runtime.
  useEffect(() => {
    if (selectedRuntimeId !== "hermes-agent") {
      setSelectedHermesProfile(null);
      return;
    }
    const profiles = selectedRuntime?.profiles ?? [];
    const stillAvailable =
      selectedHermesProfile &&
      profiles.some(
        (p) => p.name === selectedHermesProfile && !p.occupiedBy,
      );
    if (stillAvailable) return;
    const active = profiles.find((p) => p.isActive && !p.occupiedBy);
    const firstFree = profiles.find((p) => !p.occupiedBy);
    setSelectedHermesProfile((active ?? firstFree)?.name ?? null);
  }, [selectedRuntime, selectedRuntimeId, selectedHermesProfile]);

  const showEmptyState = loaded && onlineDaemons.length === 0;
  const trimmedName = name.trim();

  // Auto-detect daemon coming online while user stares at the install command.
  useEffect(() => {
    if (!showEmptyState && !addingDevice) return;
    const id = window.setInterval(() => {
      void refresh({ quiet: true });
    }, 3_000);
    return () => window.clearInterval(id);
  }, [showEmptyState, addingDevice, refresh]);

  // Adding a second device uses the same install panel as the empty state, so
  // it needs its own "new daemon appeared" handoff back to the picker.
  useEffect(() => {
    if (!addingDevice) return;
    const newOnlineDaemon = onlineDaemons.find(
      (d) => !addDeviceExistingIdsRef.current.has(d.id),
    );
    if (!newOnlineDaemon) return;
    setSelectedDaemonId(newOnlineDaemon.id);
    setAddingDevice(false);
  }, [addingDevice, onlineDaemons]);

  // Auto-detect OpenClaw gateways once the user picks the OpenClaw/QClaw runtime
  // but no reachable endpoint has been probed yet.
  useEffect(() => {
    if (!isOpenclawFamilyRuntime(selectedRuntimeId)) return;
    if (!selectedDaemon) return;
    const reachable = (selectedRuntime?.endpoints ?? []).filter((e) => e.reachable);
    if (reachable.length > 0) return;
    const daemonId = selectedDaemon.id;
    const id = window.setInterval(() => {
      void refreshRuntimes(daemonId, { quiet: true });
    }, 5_000);
    return () => window.clearInterval(id);
  }, [selectedRuntimeId, selectedDaemon, selectedRuntime, refreshRuntimes]);

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
        case "missing_name":
          return t.nameRequired;
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
    if (!trimmedName) {
      setError(t.nameRequired);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await provisionAgent(selectedDaemonId, {
        name: trimmedName,
        bio: bio.trim() || undefined,
        runtime: daemonRuntimeId(selectedRuntimeId),
        ...(isOpenclawFamilyRuntime(selectedRuntimeId) && selectedGateway
          ? {
              openclawGateway: selectedGateway,
              ...(selectedOpenclawAgent ? { openclawAgent: selectedOpenclawAgent } : {}),
            }
          : {}),
        ...(selectedRuntimeId === "hermes-agent" && selectedHermesProfile
          ? { hermesProfile: selectedHermesProfile }
          : {}),
      });
      await onSuccess(res.agentId);
      onClose();
    } catch (err) {
      setError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const needsOpenclawGateway = isOpenclawFamilyRuntime(selectedRuntimeId);
  const needsHermesProfile = selectedRuntimeId === "hermes-agent";
  const needsOpenclawAgent =
    needsOpenclawGateway && (selectedOpenclawEndpoint?.agents?.length ?? 0) > 0;
  const canSubmit =
    !!selectedDaemonId &&
    !!selectedRuntimeId &&
    !!trimmedName &&
    (!needsOpenclawGateway || !!selectedGateway) &&
    (!needsOpenclawAgent || !!selectedOpenclawAgent) &&
    (!needsHermesProfile || !!selectedHermesProfile) &&
    !submitting;

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
          <DaemonInstallCommand
            busy={loading}
            onRefresh={() => void refresh()}
            labels={{
              title: t.noDaemonTitle,
              hint: t.noDaemonHint,
              copy: t.copy,
              copied: t.copied,
              refresh: t.refreshDaemons,
            }}
          />
        ) : addingDevice ? (
          <div className="space-y-4">
            <DaemonInstallCommand
              busy={loading}
              onRefresh={() => void refresh()}
              labels={{
                title: t.addDeviceTitle,
                hint: t.addDeviceHint,
                copy: t.copy,
                copied: t.copied,
                refresh: t.refreshDaemons,
              }}
            />
            <button
              type="button"
              onClick={() => setAddingDevice(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t.backLabel}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  {t.daemonLabel}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    addDeviceExistingIdsRef.current = new Set(
                      daemons.map((d) => d.id),
                    );
                    setAddingDevice(true);
                  }}
                  disabled={submitting}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  {t.addDeviceLabel}
                </button>
              </div>
              {onlineDaemons.length > 1 ? (
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
              ) : selectedDaemon ? (
                <div className="flex items-center gap-2 rounded-xl border border-glass-border bg-glass-bg/40 px-3 py-2 text-xs text-text-secondary">
                  <Server className="h-3.5 w-3.5 text-neon-cyan" />
                  <span className="text-text-primary">
                    {selectedDaemon.label || selectedDaemon.id}
                  </span>
                  <span className="ml-auto inline-flex h-1.5 w-1.5 rounded-full bg-neon-green" />
                </div>
              ) : null}
            </div>

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

            {needsOpenclawGateway && (
              <OpenclawGatewayPicker
                runtime={selectedRuntime}
                selectedGateway={selectedGateway}
                onSelectGateway={(g) => {
                  setSelectedGateway(g);
                  setSelectedOpenclawAgent(null);
                }}
                selectedAgent={selectedOpenclawAgent}
                onSelectAgent={setSelectedOpenclawAgent}
                labels={{
                  subagentLabel: t.openclawSubagentLabel,
                  subagentInfo: t.openclawSubagentInfo,
                  subagentPlaceholder: t.openclawSubagentPlaceholder,
                  noProfiles: t.openclawNoProfiles,
                  selectProfile: t.openclawSelectProfile,
                  boundProfiles: t.openclawBoundProfiles,
                }}
                disabled={submitting}
              />
            )}

            {needsHermesProfile && (
              <HermesProfilePicker
                runtime={selectedRuntime}
                selectedProfile={selectedHermesProfile}
                onSelect={setSelectedHermesProfile}
                disabled={submitting}
              />
            )}

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  {t.nameLabel}
                </label>
                <button
                  type="button"
                  onClick={handleRandomize}
                  disabled={submitting}
                  title={t.randomizeTooltip}
                  aria-label={t.randomizeTooltip}
                  className="inline-flex items-center justify-center rounded-md p-1 text-text-secondary transition-colors hover:bg-glass-bg hover:text-neon-cyan disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                </button>
              </div>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  const nextName = e.target.value;
                  setName(nextName);
                  if (nextName !== autoFilledNameRef.current) {
                    autoFilledNameRef.current = null;
                  }
                  if (error === t.nameRequired && nextName.trim()) {
                    setError(null);
                  }
                }}
                placeholder={t.namePlaceholder}
                disabled={submitting}
                className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
                maxLength={64}
              />
              <p className="mt-1.5 text-xs leading-5 text-text-secondary">
                {t.nameHint}
              </p>
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
              <p className="mt-1.5 text-xs leading-5 text-text-secondary">
                {t.bioHint}
              </p>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
            {error}
          </p>
        )}

        {!showEmptyState && !addingDevice && loaded && (
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
  const sortedRuntimes = [...runtimes].sort((a, b) => {
    if (a.available === b.available) return 0;
    return a.available ? -1 : 1;
  });
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
          className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg px-3 py-1.5 text-xs font-semibold text-text-primary transition-colors hover:border-neon-cyan/60 hover:bg-neon-cyan/10 hover:text-neon-cyan disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          {labels.probeRuntimes}
        </button>
      </div>

      {!hasAny ? (
        <div className="rounded-xl border border-dashed border-glass-border bg-glass-bg/40 px-3 py-4 text-center text-xs text-text-secondary">
          {labels.noRuntimesDetected}
        </div>
      ) : (
        <div className="grid gap-2">
          {sortedRuntimes.map((r) => (
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

function OpenclawGatewayPicker({
  runtime,
  selectedGateway,
  onSelectGateway,
  selectedAgent,
  onSelectAgent,
  labels,
  disabled,
}: {
  runtime: DaemonRuntime | null;
  selectedGateway: string | null;
  onSelectGateway: (name: string | null) => void;
  selectedAgent: string | null;
  onSelectAgent: (name: string | null) => void;
  labels: {
    subagentLabel: string;
    subagentInfo: string;
    subagentPlaceholder: string;
    noProfiles: string;
    selectProfile: string;
    boundProfiles: (count: number) => string;
  };
  disabled: boolean;
}) {
  const endpoints = runtime?.endpoints ?? [];
  const reachable = endpoints.filter((e) => e.reachable);
  const current = endpoints.find((e) => e.name === selectedGateway) ?? null;
  const agents = current?.agents ?? [];
  const availableAgents = agents.filter((a) => !a.botcordBinding?.agentId);
  const boundCount = agents.length - availableAgents.length;
  if (endpoints.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-glass-border bg-glass-bg/40 px-3 py-3 text-xs text-text-secondary">
        No OpenClaw gateways configured on this daemon. Add an entry to
        <code className="mx-1 font-mono">openclawGateways</code>
        in the daemon config and refresh.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Gateway
        </label>
        <select
          disabled={disabled}
          value={selectedGateway ?? ""}
          onChange={(e) => onSelectGateway(e.target.value || null)}
          className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary"
        >
          <option value="" disabled>
            Select a gateway
          </option>
          {endpoints.map((e) => (
            <option key={e.name} value={e.name} disabled={!e.reachable}>
              {e.name} — {e.url} {e.reachable ? `(${e.version ?? "ok"})` : `✗ ${e.error ?? "unreachable"}`}
            </option>
          ))}
        </select>
        {reachable.length === 0 && (
          <p className="mt-1 text-[11px] text-orange-400">
            No reachable gateways. Check tokens, daemon network access, or refresh runtimes.
          </p>
        )}
      </div>
      <div>
        <div className="mb-1.5 flex items-center gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            {labels.subagentLabel}
          </label>
          <span
            title={labels.subagentInfo}
            className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-glass-border text-text-tertiary"
            aria-label={labels.subagentInfo}
          >
            <Info className="h-3 w-3" />
          </span>
        </div>
        {agents.length === 0 ? (
          <input
            disabled={disabled || !selectedGateway}
            type="text"
            value={selectedAgent ?? ""}
            placeholder={labels.subagentPlaceholder}
            onChange={(e) => onSelectAgent(e.target.value.trim() || null)}
            className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary"
          />
        ) : (
          <select
            disabled={disabled || !selectedGateway || availableAgents.length === 0}
            value={selectedAgent ?? ""}
            onChange={(e) => onSelectAgent(e.target.value || null)}
            className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary"
          >
            <option value="" disabled>
              {availableAgents.length === 0 ? labels.noProfiles : labels.selectProfile}
            </option>
            {availableAgents.map((a) => {
              const label =
                (a.name && a.name !== a.id ? `${a.name} (${a.id})` : a.id) +
                (a.model?.name ? ` — ${a.model.name}` : "");
              return (
                <option key={a.id} value={a.id}>
                  {label}
                </option>
              );
            })}
          </select>
        )}
        {boundCount > 0 && (
          <p className="mt-1 text-[11px] text-text-tertiary">
            {labels.boundProfiles(boundCount)}
          </p>
        )}
      </div>
    </div>
  );
}

function HermesProfilePicker({
  runtime,
  selectedProfile,
  onSelect,
  disabled,
}: {
  runtime: DaemonRuntime | null;
  selectedProfile: string | null;
  onSelect: (name: string | null) => void;
  disabled: boolean;
}) {
  const profiles = runtime?.profiles ?? [];
  if (!runtime?.available) {
    return null;
  }
  if (profiles.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-glass-border bg-glass-bg/40 px-3 py-3 text-xs text-text-secondary">
        No hermes profiles detected. Make sure hermes is installed and run{" "}
        <code className="mx-1 font-mono">hermes profile create &lt;name&gt;</code>
        on this device, then refresh runtimes.
      </div>
    );
  }
  const allOccupied = profiles.every((p) => !!p.occupiedBy);
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
        Hermes profile
      </label>
      <select
        disabled={disabled}
        value={selectedProfile ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
        className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary"
      >
        <option value="" disabled>
          Select a profile
        </option>
        {profiles.map((p) => {
          const occupied = !!p.occupiedBy;
          const labelParts: string[] = [p.name];
          if (p.isDefault) labelParts.push("(default)");
          if (p.modelName) labelParts.push(`— ${p.modelName}`);
          if (occupied) {
            labelParts.push(
              `· bound to ${p.occupiedByName ?? p.occupiedBy ?? "another agent"}`,
            );
          } else if (p.isActive) {
            labelParts.push("· active");
          }
          return (
            <option key={p.name} value={p.name} disabled={occupied}>
              {labelParts.join(" ")}
            </option>
          );
        })}
      </select>
      <p className="mt-1 text-[11px] text-text-tertiary">
        BotCord agent attaches to this profile&apos;s{" "}
        <code className="font-mono">HERMES_HOME</code>; sessions, memory and
        skills are shared with your command-line <code className="font-mono">hermes</code>.
      </p>
      {allOccupied && (
        <p className="mt-1 text-[11px] text-orange-400">
          All profiles are bound. Run{" "}
          <code className="font-mono">hermes profile create &lt;name&gt; --clone</code>{" "}
          on this device and refresh.
        </p>
      )}
    </div>
  );
}

// ── OpenClaw branch ─────────────────────────────────────────────────────────

interface OpenclawBranchProps {
  onSuccess: (agentId: string) => Promise<void> | void;
  onClose: () => void;
}

type OpenclawTarget = { kind: "host"; hostId: string } | { kind: "new" };

function OpenclawBranch({ onSuccess, onClose }: OpenclawBranchProps) {
  const hosts = useOpenclawHostStore((s) => s.hosts);
  const loaded = useOpenclawHostStore((s) => s.loaded);
  const refresh = useOpenclawHostStore((s) => s.refresh);
  const issueInstall = useOpenclawHostStore((s) => s.issueInstall);
  const provisionOnHost = useOpenclawHostStore((s) => s.provisionOnHost);

  const [target, setTarget] = useState<OpenclawTarget>({ kind: "new" });
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<OpenclawInstallTicket | null>(null);
  const [manualAttachNotice, setManualAttachNotice] = useState<{
    agentId: string;
    reason: string | null;
  } | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Default to a registered online host if any exist.
  useEffect(() => {
    if (target.kind === "host") return;
    const onlineHost = hosts.find((h) => h.online && !h.revoked_at);
    if (onlineHost) setTarget({ kind: "host", hostId: onlineHost.id });
  }, [hosts, target.kind]);

  function describeError(err: unknown): string {
    if (err instanceof OpenclawProvisionError) {
      return err.detail || err.message;
    }
    return err instanceof Error ? err.message : "Failed";
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      if (target.kind === "host") {
        const res = await provisionOnHost(target.hostId, {
          name: trimmedName,
          bio: bio.trim() || undefined,
        });
        await onSuccess(res.agentId);
        if (!res.configPatched) {
          // Agent IS created on Hub and credentials landed on disk,
          // but the host couldn't auto-attach (multi-account guard or
          // IO error). Don't auto-close — render a visible notice so
          // the user knows a manual config edit is required before the
          // agent will actually start sending/receiving.
          setManualAttachNotice({
            agentId: res.agentId,
            reason: res.configSkipReason,
          });
          return;
        }
        onClose();
      } else {
        const t = await issueInstall({
          name: trimmedName,
          bio: bio.trim() || undefined,
        });
        setTicket(t);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (manualAttachNotice) {
    const reasonText =
      manualAttachNotice.reason === "multi_account_guard"
        ? "BotCord currently supports only one configured agent per OpenClaw host. The new credentials are on disk but you'll need to swap them into ~/.openclaw/openclaw.json (or run the install command for the new agent on a separate host)."
        : manualAttachNotice.reason === "io_error"
          ? "The plugin couldn't write to ~/.openclaw/openclaw.json — check permissions on the host."
          : "The plugin couldn't auto-register this agent in ~/.openclaw/openclaw.json.";
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-200">
          <p className="font-semibold">Agent created — manual attach required</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-100/80">
            <span className="font-mono">{manualAttachNotice.agentId}</span> was
            registered on the Hub and its credentials were written on the host,
            but it will not start sending or receiving messages until you update
            the OpenClaw config and reload the plugin.
          </p>
          <p className="mt-2 text-xs text-amber-100/70">{reasonText}</p>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-glass-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            Got it
          </button>
        </div>
      </div>
    );
  }

  if (ticket) {
    return (
      <InstallCommandPanel
        ticket={ticket}
        onClaimed={async (agentId) => {
          await onSuccess(agentId);
          onClose();
        }}
        onCancel={() => setTicket(null)}
      />
    );
  }

  const visibleHosts = hosts.filter((h) => !h.revoked_at);

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
          OpenClaw host
        </label>
        <div className="grid grid-cols-1 gap-2">
          {visibleHosts.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              selected={target.kind === "host" && target.hostId === h.id}
              onSelect={() => setTarget({ kind: "host", hostId: h.id })}
              disabled={submitting}
            />
          ))}
          <button
            type="button"
            onClick={() => setTarget({ kind: "new" })}
            disabled={submitting}
            className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
              target.kind === "new"
                ? "border-neon-cyan/60 bg-neon-cyan/10 text-text-primary"
                : "border-glass-border text-text-secondary hover:bg-glass-bg hover:text-text-primary"
            }`}
          >
            <span className="flex items-center gap-2">
              <Server className="h-4 w-4" />
              Add a new OpenClaw host
            </span>
            {target.kind === "new" && <Check className="h-4 w-4 text-neon-cyan" />}
          </button>
        </div>
        {!loaded && (
          <p className="mt-2 text-[11px] text-text-tertiary">Loading registered hosts…</p>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Agent name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. research-bot"
          disabled={submitting}
          className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
          maxLength={64}
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Bio (optional)
        </label>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="What this bot is for"
          disabled={submitting}
          rows={2}
          className="w-full resize-none rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
          maxLength={240}
        />
      </div>

      {error && (
        <p className="rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting || !name.trim()}
          className="flex items-center gap-2 rounded-xl border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2.5 text-sm font-bold text-neon-cyan transition-all hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Working…
            </>
          ) : target.kind === "new" ? (
            "Get install command"
          ) : (
            "Create"
          )}
        </button>
      </div>
    </div>
  );
}

function HostCard({
  host,
  selected,
  onSelect,
  disabled,
}: {
  host: OpenclawHost;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled || !host.online}
      className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
        selected
          ? "border-neon-cyan/60 bg-neon-cyan/10 text-text-primary"
          : "border-glass-border text-text-secondary hover:bg-glass-bg hover:text-text-primary"
      } ${!host.online ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <span className="flex items-center gap-2">
        <Server className="h-4 w-4 text-neon-cyan" />
        <span className="text-text-primary">{host.label || host.id}</span>
        {host.online ? (
          <span className="ml-1 inline-flex h-1.5 w-1.5 rounded-full bg-neon-green" />
        ) : (
          <span className="ml-1 text-[10px] uppercase tracking-wider text-text-tertiary">
            offline
          </span>
        )}
      </span>
      <span className="text-[11px] text-text-tertiary">
        {host.agent_count} agent{host.agent_count === 1 ? "" : "s"}
      </span>
    </button>
  );
}
