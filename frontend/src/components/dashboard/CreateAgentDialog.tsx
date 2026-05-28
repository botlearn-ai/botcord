"use client";

/**
 * [INPUT]: useDaemonStore for daemon/runtime discovery + provision_agent dispatch; i18n createAgentDialog
 * [OUTPUT]: CreateAgentDialog — picks a daemon + runtime, provisions a new agent on that daemon
 * [POS]: opened from AccountMenu "Create Agent" action; success refreshes the agent list
 * [PROTOCOL]: update header on changes
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  Feather,
  Gem,
  Info,
  Loader2,
  Network,
  Plus,
  RefreshCcw,
  Server,
  Sparkles,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { createAgentDialog } from "@/lib/i18n/translations/dashboard";
import { pickRandomAgentIdentity } from "@/lib/random-agent-identity";
import {
  useDaemonStore,
  ProvisionAgentError,
  type DaemonInstance,
  type DaemonRuntime,
  type DaemonRuntimeModel,
  type DaemonRuntimeParameter,
  type DaemonRuntimeParameterValue,
} from "@/store/useDaemonStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import {
  useOpenclawHostStore,
  OpenclawProvisionError,
  type OpenclawHost,
  type OpenclawInstallTicket,
} from "@/store/useOpenclawHostStore";
import InstallCommandPanel from "./InstallCommandPanel";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";
import { DeviceConnectPanel } from "./HomePanel";
import DashboardSelect from "./DashboardSelect";

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
const CLOUD_AGENT_OPTION_ID = "__botcord_cloud_agent__";

type DaemonRuntimeEndpoint = NonNullable<DaemonRuntime["endpoints"]>[number];

function parameterValueKey(value: DaemonRuntimeParameterValue): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}

function findRuntimeParameter(
  runtime: DaemonRuntime | null,
  model: DaemonRuntimeModel | null,
  ids: string[],
): DaemonRuntimeParameter | null {
  const modelParam = model?.parameters?.find((param) => ids.includes(param.id));
  if (modelParam) return modelParam;
  return runtime?.parameters?.find((param) => ids.includes(param.id)) ?? null;
}

function modelLabel(model: DaemonRuntimeModel): string {
  return model.displayName && model.displayName !== model.id
    ? `${model.displayName} (${model.id})`
    : model.id;
}

function isOpenclawFamilyRuntime(id: string | null): boolean {
  return id === OPENCLAW_RUNTIME_ID || id === QCLAW_RUNTIME_ID;
}

function daemonRuntimeId(id: string): string {
  return id === QCLAW_RUNTIME_ID ? OPENCLAW_RUNTIME_ID : id;
}

async function createCloudAgent(input: {
  name: string;
  bio?: string;
  runtime?: string;
  runtimeModel?: string;
  reasoningEffort?: string;
  thinking?: boolean;
}): Promise<{ agentId: string }> {
  const res = await apiFetch("/api/cloud-agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      ...(input.bio ? { bio: input.bio } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.runtimeModel ? { runtime_model: input.runtimeModel } : {}),
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      ...(typeof input.thinking === "boolean" ? { thinking: input.thinking } : {}),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    const detail = data?.detail;
    const message =
      typeof detail === "object" && detail && typeof detail.message === "string"
        ? detail.message
        : typeof detail === "string"
          ? detail
          : typeof data?.error === "string"
            ? data.error
            : res.statusText;
    throw new Error(message);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const agentId =
    typeof data?.agent_id === "string"
      ? data.agent_id
      : typeof data?.agentId === "string"
        ? data.agentId
        : null;
  if (!agentId) {
    throw new ProvisionAgentError("missing_agent_id");
  }
  return { agentId };
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

function WizardStepper({
  current,
  deviceDone,
  step1Label,
  step2Label,
}: {
  current: 1 | 2;
  deviceDone: boolean;
  step1Label: string;
  step2Label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <StepperPill
        index={1}
        label={step1Label}
        state={deviceDone ? "done" : current === 1 ? "active" : "upcoming"}
      />
      <div
        className={`h-px w-8 ${deviceDone ? "bg-neon-cyan/40" : "bg-glass-border"}`}
      />
      <StepperPill
        index={2}
        label={step2Label}
        state={current === 2 ? "active" : deviceDone ? "upcoming" : "locked"}
      />
    </div>
  );
}

function StepperPill({
  index,
  label,
  state,
}: {
  index: number;
  label: string;
  state: "active" | "done" | "upcoming" | "locked";
}) {
  const isActive = state === "active";
  const isDone = state === "done";
  const isLocked = state === "locked";
  const badgeClass = isDone
    ? "border-neon-cyan bg-neon-cyan text-deep-black"
    : isActive
      ? "border-neon-cyan bg-neon-cyan/20 text-neon-cyan"
      : isLocked
        ? "border-glass-border text-text-tertiary"
        : "border-glass-border text-text-secondary";
  const labelClass = isActive
    ? "text-text-primary"
    : isDone
      ? "text-text-primary/85"
      : isLocked
        ? "text-text-tertiary"
        : "text-text-secondary";
  return (
    <div className="flex items-center gap-2">
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold ${badgeClass}`}
      >
        {isDone ? <Check className="h-3 w-3" /> : index}
      </span>
      <span className={`text-xs font-medium ${labelClass}`}>{label}</span>
    </div>
  );
}

export default function CreateAgentDialog({
  onClose,
  onSuccess,
  preselectedDaemonId,
}: CreateAgentDialogProps) {
  const locale = useLanguage();
  const t = createAgentDialog[locale];

  const hasExistingBots = useDashboardSessionStore(
    (s) => s.ownedAgents.length > 0,
  );
  const daemons = useDaemonStore((s) => s.daemons);
  const loading = useDaemonStore((s) => s.loading);
  const loaded = useDaemonStore((s) => s.loaded);
  const refresh = useDaemonStore((s) => s.refresh);
  const refreshingRuntimesId = useDaemonStore((s) => s.refreshingRuntimesId);
  const refreshRuntimes = useDaemonStore((s) => s.refreshRuntimes);
  const provisionAgent = useDaemonStore((s) => s.provisionAgent);

  const onlineDaemons = useMemo(
    () => daemons.filter((d) => d.status === "online" && d.kind !== "cloud"),
    [daemons],
  );
  const cloudRuntimeDaemon = useMemo(() => {
    const candidates = daemons.filter(
      (d) =>
        d.kind === "cloud" &&
        d.status !== "revoked" &&
        d.status !== "removal_pending",
    );
    const selected =
      candidates.find((d) => d.status === "online" && (d.runtimes?.length ?? 0) > 0) ??
      candidates.find((d) => (d.runtimes?.length ?? 0) > 0) ??
      candidates.find((d) => d.status === "online") ??
      candidates[0] ??
      null;
    if (!selected) return null;
    return { ...selected, runtimes: applyRuntimeSupport(selected.runtimes, t.runtimeNotSupported) };
  }, [daemons, t.runtimeNotSupported]);
  const deviceOptions = useMemo(
    () => [
      ...onlineDaemons.map((d, index) => ({
        value: d.id,
        label: `${d.label || d.id}${index === onlineDaemons.length - 1 ? " · latest" : ""}`,
        sublabel: d.id,
      })),
      {
        value: CLOUD_AGENT_OPTION_ID,
        label: t.cloudAgentOptionLabel,
        sublabel: t.cloudAgentOptionHint,
      },
    ],
    [onlineDaemons, t.cloudAgentOptionHint, t.cloudAgentOptionLabel],
  );
  const hasOfflineBoundDevices = daemons.some((d) => d.status === "offline");
  const hasOnlyOfflineBoundDevices = loaded && hasOfflineBoundDevices && onlineDaemons.length === 0;

  const [selectedDaemonId, setSelectedDaemonId] = useState<string | null>(null);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(null);
  const [selectedRuntimeModel, setSelectedRuntimeModel] = useState<string | null>(null);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<string | null>(null);
  const [selectedThinking, setSelectedThinking] = useState<boolean | null>(null);
  const [selectedGateway, setSelectedGateway] = useState<string | null>(null);
  const [selectedOpenclawAgent, setSelectedOpenclawAgent] = useState<string | null>(null);
  const [selectedHermesProfile, setSelectedHermesProfile] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingDevice, setAddingDevice] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  const prevHadOnlineRef = useRef<boolean | null>(null);
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
    if (!loaded && !loading) void refresh();
  }, [loaded, loading, refresh]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, submitting]);

  // Brief celebratory state when a daemon transitions from offline to online
  // while the user is staring at step 1. Without this, the dialog snaps to
  // step 2 with no acknowledgement that the device just connected.
  useEffect(() => {
    if (!loaded) return;
    const hasOnline = onlineDaemons.length > 0;
    const prev = prevHadOnlineRef.current;
    if (prev === false && hasOnline) {
      setJustConnected(true);
      const t = window.setTimeout(() => setJustConnected(false), 1500);
      prevHadOnlineRef.current = hasOnline;
      return () => window.clearTimeout(t);
    }
    prevHadOnlineRef.current = hasOnline;
  }, [loaded, onlineDaemons.length]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, submitting]);

  // Brief celebratory state when a daemon transitions from offline to online
  // while the user is staring at step 1. Without this, the dialog snaps to
  // step 2 with no acknowledgement that the device just connected.
  useEffect(() => {
    if (!loaded) return;
    const hasOnline = onlineDaemons.length > 0;
    const prev = prevHadOnlineRef.current;
    if (prev === false && hasOnline) {
      setJustConnected(true);
      const t = window.setTimeout(() => setJustConnected(false), 1500);
      prevHadOnlineRef.current = hasOnline;
      return () => window.clearTimeout(t);
    }
    prevHadOnlineRef.current = hasOnline;
  }, [loaded, onlineDaemons.length]);

  // Auto-select first online daemon once the list arrives.
  // If a preselectedDaemonId was provided, use that instead.
  useEffect(() => {
    if (preselectedDaemonId && onlineDaemons.some((d) => d.id === preselectedDaemonId)) {
      setSelectedDaemonId(preselectedDaemonId);
      return;
    }
    if (selectedDaemonId === CLOUD_AGENT_OPTION_ID) {
      return;
    }
    if (selectedDaemonId) {
      const stillOnline = onlineDaemons.some((d) => d.id === selectedDaemonId);
      if (stillOnline) return;
    }
    const pick = firstOnline(onlineDaemons);
    setSelectedDaemonId(pick?.id ?? CLOUD_AGENT_OPTION_ID);
  }, [onlineDaemons, selectedDaemonId, preselectedDaemonId]);

  const isCloudAgentSelected = selectedDaemonId === CLOUD_AGENT_OPTION_ID;

  const selectedDaemon = useMemo(() => {
    if (isCloudAgentSelected) return null;
    const d = daemons.find((d) => d.id === selectedDaemonId) ?? null;
    if (!d || d.status !== "online") return null;
    return { ...d, runtimes: applyRuntimeSupport(d.runtimes, t.runtimeNotSupported) };
  }, [daemons, isCloudAgentSelected, selectedDaemonId, t.runtimeNotSupported]);
  const runtimeDaemon = isCloudAgentSelected ? cloudRuntimeDaemon : selectedDaemon;

  // Auto-select first available runtime when daemon changes.
  useEffect(() => {
    if (!runtimeDaemon) {
      setSelectedRuntimeId(null);
      return;
    }
    const runtimes = runtimeDaemon.runtimes ?? [];
    const stillValid =
      selectedRuntimeId &&
      runtimes.some((r) => r.id === selectedRuntimeId && r.available);
    if (stillValid) return;
    const firstAvailable = runtimes.find((r) => r.available);
    setSelectedRuntimeId(firstAvailable?.id ?? null);
  }, [runtimeDaemon, selectedRuntimeId]);

  // Reset OpenClaw selections when leaving the OpenClaw/QClaw runtime family.
  const selectedRuntime = useMemo(
    () => runtimeDaemon?.runtimes?.find((r) => r.id === selectedRuntimeId) ?? null,
    [runtimeDaemon, selectedRuntimeId],
  );
  const selectedModel = useMemo(
    () =>
      selectedRuntime?.models?.find((model) => model.id === selectedRuntimeModel) ??
      null,
    [selectedRuntime, selectedRuntimeModel],
  );
  const reasoningParameter = useMemo(
    () =>
      findRuntimeParameter(selectedRuntime, selectedModel, [
        "reasoning_effort",
        "effort",
      ]),
    [selectedRuntime, selectedModel],
  );
  const thinkingParameter = useMemo(
    () => findRuntimeParameter(selectedRuntime, selectedModel, ["thinking"]),
    [selectedRuntime, selectedModel],
  );
  useEffect(() => {
    const models = selectedRuntime?.models ?? [];
    if (!selectedRuntime?.available || models.length === 0) {
      setSelectedRuntimeModel(null);
      return;
    }
    if (selectedRuntimeModel && models.some((model) => model.id === selectedRuntimeModel)) {
      return;
    }
    const preferred = models.find((model) => model.isDefault) ?? models[0] ?? null;
    setSelectedRuntimeModel(preferred?.id ?? null);
  }, [selectedRuntime, selectedRuntimeModel]);

  useEffect(() => {
    if (!reasoningParameter) {
      setSelectedReasoningEffort(null);
      return;
    }
    const values = reasoningParameter.values?.map(parameterValueKey) ?? [];
    const defaultValue =
      reasoningParameter.defaultValue === undefined
        ? null
        : parameterValueKey(reasoningParameter.defaultValue);
    if (values.length > 0) {
      if (selectedReasoningEffort && values.includes(selectedReasoningEffort)) {
        return;
      }
      setSelectedReasoningEffort(
        defaultValue && values.includes(defaultValue)
          ? defaultValue
          : values[0] ?? null,
      );
      return;
    }
    setSelectedReasoningEffort(selectedReasoningEffort ?? defaultValue);
  }, [reasoningParameter, selectedReasoningEffort]);

  useEffect(() => {
    if (!thinkingParameter || thinkingParameter.type !== "boolean") {
      setSelectedThinking(null);
      return;
    }
    if (selectedThinking !== null) return;
    setSelectedThinking(
      typeof thinkingParameter.defaultValue === "boolean"
        ? thinkingParameter.defaultValue
        : true,
    );
  }, [thinkingParameter, selectedThinking]);
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
    if (isCloudAgentSelected || !isOpenclawFamilyRuntime(selectedRuntimeId)) {
      setSelectedGateway(null);
      setSelectedOpenclawAgent(null);
      return;
    }
    const reachable = (selectedRuntime?.endpoints ?? []).filter((e) => e.reachable);
    if (selectedGateway && reachable.some((e) => e.name === selectedGateway)) return;
    setSelectedGateway(reachable[0]?.name ?? null);
    setSelectedOpenclawAgent(null);
  }, [isCloudAgentSelected, selectedRuntime, selectedRuntimeId, selectedGateway]);

  useEffect(() => {
    if (isCloudAgentSelected || !isOpenclawFamilyRuntime(selectedRuntimeId)) return;
    const agents = selectedOpenclawEndpoint?.agents ?? [];
    if (agents.length === 0) return;
    const stillSelectable =
      selectedOpenclawAgent &&
      selectableOpenclawAgents.some((a) => a.id === selectedOpenclawAgent);
    if (stillSelectable) return;
    setSelectedOpenclawAgent(selectableOpenclawAgents[0]?.id ?? null);
  }, [
    selectedRuntimeId,
    isCloudAgentSelected,
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
    if (isCloudAgentSelected || selectedRuntimeId !== "hermes-agent") {
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
  }, [isCloudAgentSelected, selectedRuntime, selectedRuntimeId, selectedHermesProfile]);

  const showEmptyState = deviceOptions.length === 0 && !loading;
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
    if (isCloudAgentSelected || !isOpenclawFamilyRuntime(selectedRuntimeId)) return;
    if (!selectedDaemon) return;
    const reachable = (selectedRuntime?.endpoints ?? []).filter((e) => e.reachable);
    if (reachable.length > 0) return;
    const daemonId = selectedDaemon.id;
    const id = window.setInterval(() => {
      void refreshRuntimes(daemonId, { quiet: true });
    }, 5_000);
    return () => window.clearInterval(id);
  }, [isCloudAgentSelected, selectedRuntimeId, selectedDaemon, selectedRuntime, refreshRuntimes]);

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
    if (!selectedDaemonId) return;
    if (!isCloudAgentSelected && !selectedRuntimeId) return;
    if (!trimmedName) {
      setError(t.nameRequired);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = isCloudAgentSelected
        ? await createCloudAgent({
            name: trimmedName,
            bio: bio.trim() || undefined,
            ...(selectedRuntimeId ? { runtime: daemonRuntimeId(selectedRuntimeId) } : {}),
            ...(selectedRuntimeModel ? { runtimeModel: selectedRuntimeModel } : {}),
            ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
            ...(selectedThinking !== null ? { thinking: selectedThinking } : {}),
          })
        : await provisionAgent(selectedDaemonId, {
            name: trimmedName,
            bio: bio.trim() || undefined,
            runtime: daemonRuntimeId(selectedRuntimeId!),
            ...(selectedRuntimeModel ? { runtimeModel: selectedRuntimeModel } : {}),
            ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
            ...(selectedThinking !== null ? { thinking: selectedThinking } : {}),
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

  const needsOpenclawGateway =
    !isCloudAgentSelected && isOpenclawFamilyRuntime(selectedRuntimeId);
  const needsHermesProfile = !isCloudAgentSelected && selectedRuntimeId === "hermes-agent";
  const needsOpenclawAgent =
    needsOpenclawGateway && (selectedOpenclawEndpoint?.agents?.length ?? 0) > 0;
  const hasRuntimeModelOptions =
    (selectedRuntime?.models?.length ?? 0) > 0 ||
    !!reasoningParameter ||
    thinkingParameter?.type === "boolean";
  const canSubmit =
    !!selectedDaemonId &&
    (isCloudAgentSelected || !!selectedRuntimeId) &&
    !!trimmedName &&
    (isCloudAgentSelected || !needsOpenclawGateway || !!selectedGateway) &&
    (isCloudAgentSelected || !needsOpenclawAgent || !!selectedOpenclawAgent) &&
    (isCloudAgentSelected || !needsHermesProfile || !!selectedHermesProfile) &&
    !submitting;

  const selectedRuntimeDetails: ReactNode =
    hasRuntimeModelOptions || needsOpenclawGateway || needsHermesProfile ? (
      <div className="ml-5 space-y-2 border-l border-neon-cyan/25 pl-4">
        <RuntimeModelOptions
          runtime={selectedRuntime}
          selectedModel={selectedRuntimeModel}
          onSelectModel={setSelectedRuntimeModel}
          reasoningParameter={reasoningParameter}
          selectedReasoningEffort={selectedReasoningEffort}
          onSelectReasoningEffort={setSelectedReasoningEffort}
          thinkingParameter={thinkingParameter}
          selectedThinking={selectedThinking}
          onSelectThinking={setSelectedThinking}
          labels={{
            modelLabel: t.modelLabel,
            modelPlaceholder: t.modelPlaceholder,
            reasoningEffortLabel: t.reasoningEffortLabel,
            reasoningEffortPlaceholder: t.reasoningEffortPlaceholder,
            thinkingLabel: t.thinkingLabel,
          }}
          disabled={submitting}
        />
        {needsOpenclawGateway ? (
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
        ) : needsHermesProfile ? (
          <HermesProfilePicker
            runtime={selectedRuntime}
            selectedProfile={selectedHermesProfile}
            onSelect={setSelectedHermesProfile}
            disabled={submitting}
          />
        ) : null}
      </div>
    ) : null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-agent-title"
        className="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-glass-border bg-deep-black-light shadow-2xl"
      >
        {(() => {
          const onStep1 = showEmptyState || addingDevice;
          const currentStep: 1 | 2 = onStep1 ? 1 : 2;
          const showWizardHeader = !hasExistingBots || (onStep1 && hasOnlyOfflineBoundDevices);
          const step1Title = hasOnlyOfflineBoundDevices ? t.step1OfflineTitle : t.step1Title;
          const step1Description = hasOnlyOfflineBoundDevices
            ? t.step1OfflineDescription
            : t.step1Description;
          return (
            <>
              <div className="flex shrink-0 items-center gap-3 border-b border-glass-border/40 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  {!showWizardHeader ? (
                    <h3
                      id={onStep1 ? undefined : "create-agent-title"}
                      className="flex items-center gap-2 text-base font-semibold text-text-primary"
                    >
                      <Bot className="h-4 w-4 text-neon-cyan" />
                      {t.title}
                    </h3>
                  ) : (
                    <WizardStepper
                      current={currentStep}
                      deviceDone={!onStep1}
                      step1Label={t.stepDeviceLabel}
                      step2Label={t.stepBotLabel}
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  aria-label={t.cancel}
                  className="shrink-0 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
              {onStep1 && !addingDevice ? (
                <div className="mb-4">
                  <h3 id="create-agent-title" className="flex items-center gap-2 text-xl font-bold text-text-primary">
                    <Server className="h-5 w-5 text-neon-cyan" />
                    {step1Title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-6 text-text-secondary">
                    {step1Description}
                  </p>
                </div>
              ) : null}
              {!hasExistingBots && !onStep1 && (
                <div className="mb-4">
                  <h3 id="create-agent-title" className="flex items-center gap-2 text-xl font-bold text-text-primary">
                    <Bot className="h-5 w-5 text-neon-cyan" />
                    {t.title}
                  </h3>
                  <p className="mt-1.5 text-sm text-text-secondary">{t.step2Description}</p>
                </div>
              )}

        {!loaded && loading ? (
          <div className="flex items-center justify-center py-10 text-text-secondary">
            <MobileBotCordLoading
              label={locale === "zh" ? "正在加载设备..." : "Loading devices..."}
              textClassName="text-sm text-text-secondary"
            />
          </div>
        ) : showEmptyState ? (
          <DeviceConnectPanel
            connected={false}
            daemonLoading={loading}
            onRefreshDaemons={() => void refresh()}
            offlineDevices={hasOnlyOfflineBoundDevices}
          />
        ) : justConnected ? (
          <div className="animate-in fade-in duration-200 flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-neon-green/40 bg-neon-green/10 text-neon-green">
              <Check className="h-6 w-6" />
            </span>
            <div className="text-base font-semibold text-text-primary">
              {locale === "zh" ? "设备已就绪" : "Device connected"}
            </div>
            <div className="text-xs text-text-secondary">
              {locale === "zh" ? "正在为你打开 Bot 创建表单…" : "Opening Bot setup…"}
            </div>
          </div>
        ) : addingDevice ? (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setAddingDevice(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t.backLabel}
            </button>
            <DeviceConnectPanel
              connected={false}
              daemonLoading={loading}
              onRefreshDaemons={() => void refresh()}
              offlineDevices={false}
            />
          </div>
        ) : (
          <div className="space-y-4">
            {hasExistingBots ? null : (
              <div className="text-base font-semibold text-neon-cyan/85">
                {t.runtimeSectionLabel}
              </div>
            )}
            <div className={hasExistingBots ? "space-y-3.5" : "space-y-3.5 rounded-2xl border border-glass-border/60 bg-glass-bg/20 p-3.5"}>
            <section>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label className="text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
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
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-neon-cyan/80 transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  {t.addDeviceLabel}
                </button>
              </div>
              {deviceOptions.length > 1 ? (
                <DashboardSelect
                  value={selectedDaemonId}
                  onChange={(value) => {
                    if (value) setSelectedDaemonId(value);
                  }}
                  disabled={submitting}
                  placeholder={t.daemonLabel}
                  leadingIcon={
                    isCloudAgentSelected
                      ? <Cloud className="h-3.5 w-3.5 text-neon-cyan" />
                      : <Server className="h-3.5 w-3.5 text-neon-cyan" />
                  }
                  buttonClassName="min-h-11 pl-3"
                  options={deviceOptions}
                />
              ) : isCloudAgentSelected ? (
                <div className="flex h-11 items-center gap-2 rounded-xl border border-glass-border bg-deep-black px-3 text-xs text-text-secondary">
                  <Cloud className="h-3.5 w-3.5 text-neon-cyan" />
                  <span className="text-text-primary">
                    {t.cloudAgentOptionLabel}
                  </span>
                  <span className="ml-auto text-[11px] text-text-secondary/70">
                    {t.cloudAgentOptionHint}
                  </span>
                </div>
              ) : selectedDaemon ? (
                <div className="flex h-11 items-center gap-2 rounded-xl border border-glass-border bg-deep-black px-3 text-xs text-text-secondary">
                  <Server className="h-3.5 w-3.5 text-neon-cyan" />
                  <span className="text-text-primary">
                    {selectedDaemon.label || selectedDaemon.id}
                  </span>
                  <span className="ml-auto inline-flex h-1.5 w-1.5 rounded-full bg-neon-green" />
                </div>
              ) : null}
            </section>

            {isCloudAgentSelected ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-xl border border-neon-cyan/20 bg-neon-cyan/5 px-3 py-2.5 text-xs leading-5 text-text-secondary">
                  <Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neon-cyan" />
                  <span>{t.cloudAgentSelectedHint}</span>
                </div>
                {cloudRuntimeDaemon ? (
                  <RuntimePicker
                    daemon={cloudRuntimeDaemon}
                    selectedRuntimeId={selectedRuntimeId}
                    onSelect={setSelectedRuntimeId}
                    selectedRuntimeDetails={selectedRuntimeDetails}
                    refreshing={refreshingRuntimesId === cloudRuntimeDaemon.id}
                    onRefresh={() => {
                      void refreshRuntimes(cloudRuntimeDaemon.id);
                    }}
                    labels={{
                      runtimeLabel: t.runtimeLabel,
                      runtimeLabelWithCount: t.runtimeLabelWithCount,
                      runtimeAvailable: t.runtimeAvailable,
                      noRuntimesDetected: t.noRuntimesDetected,
                      probeRuntimes: t.probeRuntimes,
                      unavailable: t.runtimeUnavailable,
                      runtimeUnavailableGroup: t.runtimeUnavailableGroup,
                      runtimeFound: t.runtimeFound,
                      runtimeUnavailableCount: t.runtimeUnavailableCount,
                      showUnavailable: t.showUnavailable,
                      hideUnavailable: t.hideUnavailable,
                    }}
                    disabled={submitting}
                  />
                ) : null}
              </div>
            ) : (
              <RuntimePicker
                daemon={selectedDaemon}
                selectedRuntimeId={selectedRuntimeId}
                onSelect={setSelectedRuntimeId}
                selectedRuntimeDetails={selectedRuntimeDetails}
                refreshing={
                  !!selectedDaemon &&
                  refreshingRuntimesId === selectedDaemon.id
                }
                onRefresh={() => {
                  if (selectedDaemon) void refreshRuntimes(selectedDaemon.id);
                }}
                labels={{
                  runtimeLabel: t.runtimeLabel,
                  runtimeLabelWithCount: t.runtimeLabelWithCount,
                  runtimeAvailable: t.runtimeAvailable,
                  noRuntimesDetected: t.noRuntimesDetected,
                  probeRuntimes: t.probeRuntimes,
                  unavailable: t.runtimeUnavailable,
                  runtimeUnavailableGroup: t.runtimeUnavailableGroup,
                  runtimeFound: t.runtimeFound,
                  runtimeUnavailableCount: t.runtimeUnavailableCount,
                  showUnavailable: t.showUnavailable,
                  hideUnavailable: t.hideUnavailable,
                }}
                disabled={submitting}
              />
            )}

            </div>

            {hasExistingBots ? null : (
              <div className="text-base font-semibold text-neon-cyan/85">
                {t.identitySectionLabel}
              </div>
            )}
            <div className={hasExistingBots ? "space-y-3.5" : "space-y-3.5 rounded-2xl border border-glass-border/60 bg-glass-bg/20 p-3.5"}>
            <section>
              <div className="mb-1 flex items-center justify-between gap-3">
                <label className="text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
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
              <p className="mb-1.5 text-xs leading-5 text-text-secondary">
                {t.nameHint}
              </p>
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
                className="h-10 w-full rounded-xl border border-glass-border bg-deep-black px-3 text-sm text-text-primary placeholder-text-tertiary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
                maxLength={64}
              />
            </section>

            <section>
              <label className="mb-1 block text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
                {t.bioLabel}
              </label>
              <p className="mb-1.5 text-xs leading-5 text-text-secondary">
                {t.bioHint}
              </p>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder={t.bioPlaceholder}
                disabled={submitting}
                rows={2}
                className="h-16 w-full resize-none rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
                maxLength={240}
              />
            </section>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
            {error}
          </p>
        )}
              </div>

              {!showEmptyState && !addingDevice && loaded && (
                <div className="flex shrink-0 items-center justify-end gap-3 border-t border-glass-border/40 px-4 py-3 sm:px-5">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={submitting}
                    className="rounded-xl border border-glass-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSubmit()}
                    disabled={!canSubmit}
                    className="flex items-center gap-2 rounded-xl border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm font-bold text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
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
            </>
          );
        })()}
      </div>
    </div>
  );
}

function RuntimePicker({
  daemon,
  selectedRuntimeId,
  onSelect,
  selectedRuntimeDetails,
  refreshing,
  onRefresh,
  disabled,
  labels,
}: {
  daemon: DaemonInstance | null;
  selectedRuntimeId: string | null;
  onSelect: (id: string) => void;
  selectedRuntimeDetails: ReactNode;
  refreshing: boolean;
  onRefresh: () => void;
  disabled: boolean;
  labels: {
    runtimeLabel: string;
    runtimeLabelWithCount: (count: number) => string;
    runtimeAvailable: string;
    noRuntimesDetected: string;
    probeRuntimes: string;
    unavailable: string;
    runtimeUnavailableGroup: string;
    runtimeFound: (count: number) => string;
    runtimeUnavailableCount: (count: number) => string;
    showUnavailable: string;
    hideUnavailable: string;
  };
}) {
  const runtimes = daemon?.runtimes ?? [];
  const availableRuntimes = runtimes.filter((runtime) => runtime.available);
  const unavailableRuntimes = runtimes.filter((runtime) => !runtime.available);
  const hasAny = runtimes.length > 0;
  const [unavailableExpanded, setUnavailableExpanded] = useState(false);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
          {hasAny
            ? labels.runtimeLabelWithCount(availableRuntimes.length)
            : labels.runtimeLabel}
        </label>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || disabled || !daemon}
          className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg px-2 py-0.5 text-[11px] font-medium text-text-secondary transition-colors hover:border-neon-cyan/60 hover:bg-neon-cyan/10 hover:text-neon-cyan disabled:opacity-50"
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
        <div className="grid gap-3">
          {availableRuntimes.length > 0 ? (
            <div className="grid gap-2">
              {availableRuntimes.map((r) => {
                const selected = selectedRuntimeId === r.id;
                return (
                  <div key={r.id} className="space-y-2">
                    <RuntimeCard
                      runtime={r}
                      selected={selected}
                      disabled={disabled}
                      onClick={() => onSelect(r.id)}
                      unavailableLabel={labels.unavailable}
                      availableLabel={labels.runtimeAvailable}
                    />
                    {selected && selectedRuntimeDetails}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-glass-border bg-glass-bg/40 px-3 py-4 text-center text-xs text-text-secondary">
              {labels.noRuntimesDetected}
            </div>
          )}

          {unavailableRuntimes.length > 0 ? (
            <div>
              <button
                type="button"
                aria-expanded={unavailableExpanded}
                onClick={() => setUnavailableExpanded((expanded) => !expanded)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-glass-border bg-glass-bg/30 px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
              >
                <span>
                  <span className="font-semibold uppercase tracking-wider">
                    {labels.runtimeUnavailableGroup}
                  </span>
                  <span className="ml-2 text-text-secondary/60">
                    {labels.runtimeUnavailableCount(unavailableRuntimes.length)}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-neon-cyan/80">
                  {unavailableExpanded ? labels.hideUnavailable : labels.showUnavailable}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${
                      unavailableExpanded ? "rotate-180" : ""
                    }`}
                  />
                </span>
              </button>
              {unavailableExpanded ? (
                <div className="mt-2 grid gap-2">
                  {unavailableRuntimes.map((r) => (
                    <RuntimeCard
                      key={r.id}
                      runtime={r}
                      selected={false}
                      disabled
                      onClick={() => undefined}
                      unavailableLabel={labels.unavailable}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

type RuntimeLogoEntry =
  | { kind: "img"; src: string; classes: string }
  | { kind: "icon"; Icon: LucideIcon; classes: string };

const RUNTIME_LOGO: Record<string, RuntimeLogoEntry> = {
  "claude-code": { kind: "img", src: "/runtime-logos/Claude.png", classes: "border-glass-border bg-glass-bg/40" },
  codex: { kind: "img", src: "/runtime-logos/Codex.png", classes: "border-glass-border bg-glass-bg/40" },
  "deepseek-tui": { kind: "img", src: "/runtime-logos/Deepseek.png", classes: "border-glass-border bg-glass-bg/40" },
  gemini: { kind: "img", src: "/runtime-logos/Gemini.png", classes: "border-glass-border bg-glass-bg/40" },
  "kimi-cli": { kind: "img", src: "/runtime-logos/Kimi.png", classes: "border-glass-border bg-glass-bg/40" },
  "openclaw-acp": { kind: "img", src: "/runtime-logos/Openclaw.png", classes: "border-glass-border bg-glass-bg/40" },
  qclaw: { kind: "img", src: "/runtime-logos/Qclaw.png", classes: "border-glass-border bg-glass-bg/40" },
  "hermes-agent": { kind: "img", src: "/runtime-logos/Hermes.png", classes: "border-glass-border bg-glass-bg/40" },
};

function RuntimeLogo({ runtimeId, dimmed }: { runtimeId: string; dimmed?: boolean }) {
  const entry: RuntimeLogoEntry = RUNTIME_LOGO[runtimeId] ?? {
    kind: "icon",
    Icon: Bot,
    classes: "border-glass-border bg-glass-bg/40 text-text-secondary",
  };
  if (entry.kind === "img") {
    return (
      <span
        className={`relative block h-7 w-7 shrink-0 overflow-hidden rounded-lg ${dimmed ? "opacity-50" : ""}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={entry.src} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${entry.classes} ${dimmed ? "opacity-50" : ""}`}
    >
      <entry.Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function RuntimeCard({
  runtime,
  selected,
  disabled,
  onClick,
  unavailableLabel,
  availableLabel,
}: {
  runtime: DaemonRuntime;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  unavailableLabel: string;
  availableLabel?: string;
}) {
  const base =
    "flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors";
  const state = !runtime.available
    ? "cursor-not-allowed border-glass-border bg-glass-bg/35 text-text-secondary/75"
    : selected
      ? "border-neon-cyan bg-neon-cyan/15 text-text-primary"
      : "border-glass-border bg-deep-black text-text-primary hover:border-neon-cyan/45 hover:bg-neon-cyan/10";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${state}`}
      title={runtime.path || runtime.error || runtime.id}
    >
      <RuntimeLogo runtimeId={runtime.id} dimmed={!runtime.available} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 truncate font-mono text-[13px] leading-5">
          <span className="truncate">
            {runtime.id}
            {runtime.version ? ` @ ${runtime.version}` : ""}
          </span>
          {runtime.available && availableLabel ? (
            <span className="shrink-0 rounded border border-neon-green/30 bg-neon-green/10 px-1 py-px font-sans text-[9px] font-semibold uppercase tracking-wide text-neon-green">
              {availableLabel}
            </span>
          ) : null}
        </span>
        {!runtime.available && (
          <span className="mt-0.5 block text-xs leading-4 text-text-secondary">
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

function RuntimeModelOptions({
  runtime,
  selectedModel,
  onSelectModel,
  reasoningParameter,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  thinkingParameter,
  selectedThinking,
  onSelectThinking,
  labels,
  disabled,
}: {
  runtime: DaemonRuntime | null;
  selectedModel: string | null;
  onSelectModel: (value: string | null) => void;
  reasoningParameter: DaemonRuntimeParameter | null;
  selectedReasoningEffort: string | null;
  onSelectReasoningEffort: (value: string | null) => void;
  thinkingParameter: DaemonRuntimeParameter | null;
  selectedThinking: boolean | null;
  onSelectThinking: (value: boolean | null) => void;
  labels: {
    modelLabel: string;
    modelPlaceholder: string;
    reasoningEffortLabel: string;
    reasoningEffortPlaceholder: string;
    thinkingLabel: string;
  };
  disabled: boolean;
}) {
  const models = runtime?.models ?? [];
  const reasoningValues = reasoningParameter?.values?.map(parameterValueKey) ?? [];
  const hasReasoning =
    !!reasoningParameter &&
    (reasoningValues.length > 0 || reasoningParameter.type === "string");
  const hasThinking = thinkingParameter?.type === "boolean";
  if (models.length === 0 && !hasReasoning && !hasThinking) return null;

  return (
    <section className="rounded-xl border border-glass-border bg-glass-bg/30 p-2.5">
      <div className="grid gap-2.5 sm:grid-cols-2">
        {models.length > 0 ? (
          <div className={hasReasoning || hasThinking ? "" : "sm:col-span-2"}>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              {labels.modelLabel}
            </label>
            <DashboardSelect
              disabled={disabled}
              value={selectedModel ?? ""}
              onChange={onSelectModel}
              placeholder={labels.modelPlaceholder}
              options={models.map((model) => ({
                value: model.id,
                label: modelLabel(model),
                sublabel: [
                  model.provider,
                  model.isDefault ? "default" : null,
                  model.source,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }))}
            />
          </div>
        ) : null}

        {hasReasoning ? (
          <div className={models.length > 0 ? "" : "sm:col-span-2"}>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              {labels.reasoningEffortLabel}
            </label>
            {reasoningValues.length > 0 ? (
              <DashboardSelect
                disabled={disabled}
                value={selectedReasoningEffort ?? ""}
                onChange={onSelectReasoningEffort}
                placeholder={labels.reasoningEffortPlaceholder}
                options={reasoningValues.map((value) => ({
                  value,
                  label: value,
                  sublabel:
                    reasoningParameter?.defaultValue !== undefined &&
                    parameterValueKey(reasoningParameter.defaultValue) === value
                      ? "default"
                      : undefined,
                }))}
              />
            ) : (
              <input
                disabled={disabled}
                type="text"
                value={selectedReasoningEffort ?? ""}
                placeholder={labels.reasoningEffortPlaceholder}
                onChange={(event) =>
                  onSelectReasoningEffort(event.target.value.trim() || null)
                }
                className="h-10 w-full rounded-xl border border-glass-border bg-deep-black px-3 text-sm text-text-primary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
              />
            )}
          </div>
        ) : null}

        {hasThinking ? (
          <label className="flex min-h-10 items-center gap-2 rounded-xl border border-glass-border bg-deep-black px-3 text-sm text-text-primary sm:col-span-2">
            <input
              type="checkbox"
              checked={selectedThinking === true}
              disabled={disabled}
              onChange={(event) => onSelectThinking(event.target.checked)}
              className="h-4 w-4 rounded border-glass-border bg-deep-black text-neon-cyan focus:ring-neon-cyan/50"
            />
            <span>{labels.thinkingLabel}</span>
          </label>
        ) : null}
      </div>
    </section>
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
    <section>
      <div className="rounded-xl border border-glass-border bg-glass-bg/30 p-2.5">
        <div className="grid gap-2.5">
      <div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Gateway
        </label>
        <div className="relative">
          <DashboardSelect
            disabled={disabled}
            value={selectedGateway ?? ""}
            onChange={onSelectGateway}
            placeholder="Select a gateway"
            options={endpoints.map((e) => ({
              value: e.name,
              label: e.name,
              sublabel: `${e.url} ${e.reachable ? `(${e.version ?? "ok"})` : `- ${e.error ?? "unreachable"}`}`,
              disabled: !e.reachable,
            }))}
          />
        </div>
        {reachable.length === 0 && (
          <p className="mt-1 text-[11px] text-orange-400">
            No reachable gateways. Check tokens, daemon network access, or refresh runtimes.
          </p>
        )}
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
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
            className="h-10 w-full rounded-xl border border-glass-border bg-deep-black px-3 text-sm text-text-primary focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:opacity-50"
          />
        ) : (
          <div className="relative">
            <DashboardSelect
              disabled={disabled || !selectedGateway || availableAgents.length === 0}
              value={selectedAgent ?? ""}
              onChange={onSelectAgent}
              placeholder={availableAgents.length === 0 ? labels.noProfiles : labels.selectProfile}
              options={availableAgents.map((a) => {
                const label =
                  (a.name && a.name !== a.id ? `${a.name} (${a.id})` : a.id) +
                  (a.model?.name ? ` — ${a.model.name}` : "");
                return {
                  value: a.id,
                  label,
                };
              })}
            />
          </div>
        )}
        {boundCount > 0 && (
          <p className="mt-1 text-[11px] text-text-tertiary">
            {labels.boundProfiles(boundCount)}
          </p>
        )}
      </div>
        </div>
      </div>
    </section>
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
    <section>
      <label className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
        Hermes profile
      </label>
      <div className="relative">
        <DashboardSelect
          disabled={disabled}
          value={selectedProfile ?? ""}
          onChange={onSelect}
          placeholder="Select a profile"
          options={profiles.map((p) => {
            const occupied = !!p.occupiedBy;
            const labelParts: string[] = [p.name];
            if (p.isDefault) labelParts.push("(default)");
            if (p.modelName) labelParts.push(`— ${p.modelName}`);
            const sublabelParts: string[] = [];
            if (occupied) {
              sublabelParts.push(`bound to ${p.occupiedByName ?? p.occupiedBy ?? "another agent"}`);
            } else if (p.isActive) {
              sublabelParts.push("active");
            }
            return {
              value: p.name,
              label: labelParts.join(" "),
              sublabel: sublabelParts.join(" "),
              disabled: occupied,
            };
          })}
        />
      </div>
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
    </section>
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
          ? "The host couldn't write to ~/.openclaw/openclaw.json — check permissions on the host."
          : "The host couldn't auto-register this agent in ~/.openclaw/openclaw.json.";
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-200">
          <p className="font-semibold">Agent created — manual attach required</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-100/80">
            <span className="font-mono">{manualAttachNotice.agentId}</span> was
            registered on the Hub and its credentials were written on the host,
            but it will not start sending or receiving messages until you update
            the OpenClaw config and reload the host.
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
        <label className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
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
          <MobileBotCordLoading
            label="Loading registered hosts…"
            size="sm"
            className="mt-2 justify-start"
            textClassName="text-[11px] text-text-tertiary"
          />
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
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
        <label className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
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
