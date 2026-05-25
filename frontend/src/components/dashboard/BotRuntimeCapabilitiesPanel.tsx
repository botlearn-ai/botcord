"use client";

import { Bot, Brain, Check, Cpu, Loader2, Save, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import type {
  DaemonInstance,
  DaemonRuntime,
  DaemonRuntimeModel,
  DaemonRuntimeParameter,
  DaemonRuntimeParameterValue,
} from "@/store/useDaemonStore";
import DashboardSelect from "./DashboardSelect";

interface BotRuntimeCapabilitiesPanelProps {
  agentId: string;
  daemon: DaemonInstance | null;
  runtimeId?: string | null;
  runtimeModel?: string | null;
  reasoningEffort?: string | null;
  thinking?: boolean | null;
  className?: string;
  onSaved?: () => Promise<void> | void;
}

const REASONING_PARAM_IDS = new Set(["reasoning_effort", "effort"]);
const THINKING_PARAM_IDS = new Set(["thinking"]);

function parameterValueKey(value: DaemonRuntimeParameterValue): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}

function modelLabel(model: DaemonRuntimeModel): string {
  return model.displayName && model.displayName !== model.id
    ? `${model.displayName} (${model.id})`
    : model.id;
}

function runtimeMatches(candidateId: string, runtimeId: string): boolean {
  return (
    candidateId === runtimeId ||
    (candidateId === "qclaw" && runtimeId === "openclaw-acp") ||
    (candidateId === "openclaw-acp" && runtimeId === "qclaw")
  );
}

function findRuntimeForAgent(
  agentId: string,
  daemon: DaemonInstance | null,
  runtimeId?: string | null,
): DaemonRuntime | null {
  const runtimes = daemon?.runtimes ?? [];
  if (runtimeId) {
    const direct = runtimes.find((runtime) => runtimeMatches(runtime.id, runtimeId));
    if (direct) return direct;
  }
  return (
    runtimes.find((runtime) =>
      runtime.profiles?.some((profile) => profile.occupiedBy === agentId) ||
      runtime.endpoints?.some((endpoint) =>
        endpoint.agents?.some((profile) => profile.botcordBinding?.agentId === agentId),
      ),
    ) ?? null
  );
}

function findRuntimeParameter(
  runtime: DaemonRuntime | null,
  model: DaemonRuntimeModel | null,
  ids: Set<string>,
): DaemonRuntimeParameter | null {
  return (
    model?.parameters?.find((param) => ids.has(param.id)) ??
    runtime?.parameters?.find((param) => ids.has(param.id)) ??
    null
  );
}

function defaultModelId(runtime: DaemonRuntime | null): string | null {
  const models = runtime?.models ?? [];
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
}

function resolveModelId(runtime: DaemonRuntime | null, value?: string | null): string | null {
  const models = runtime?.models ?? [];
  if (models.length === 0) return null;
  if (value && models.some((model) => model.id === value)) return value;
  return defaultModelId(runtime);
}

function resolveReasoningValue(
  param: DaemonRuntimeParameter | null,
  value?: string | null,
): string | null {
  if (!param) return null;
  const values = param.values?.map(parameterValueKey) ?? [];
  if (value && (values.length === 0 || values.includes(value))) return value;
  const defaultValue =
    param.defaultValue === undefined ? null : parameterValueKey(param.defaultValue);
  if (values.length > 0) {
    return defaultValue && values.includes(defaultValue) ? defaultValue : values[0] ?? null;
  }
  return defaultValue;
}

function resolveThinkingValue(
  param: DaemonRuntimeParameter | null,
  value?: boolean | null,
): boolean | null {
  if (param?.type !== "boolean") return null;
  if (typeof value === "boolean") return value;
  return typeof param.defaultValue === "boolean" ? param.defaultValue : true;
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">
        {label}
      </div>
      {children}
    </div>
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-5 text-text-secondary/60">{children}</p>;
}

function Chip({
  children,
  title,
  tone = "neutral",
}: {
  children: ReactNode;
  title?: string;
  tone?: "neutral" | "cyan";
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 rounded-lg border px-2 py-1 text-[11px] leading-4 ${
        tone === "cyan"
          ? "border-neon-cyan/35 bg-neon-cyan/10 text-neon-cyan"
          : "border-glass-border bg-deep-black/40 text-text-primary"
      }`}
    >
      {children}
    </span>
  );
}

export default function BotRuntimeCapabilitiesPanel({
  agentId,
  daemon,
  runtimeId,
  runtimeModel,
  reasoningEffort,
  thinking,
  className,
  onSaved,
}: BotRuntimeCapabilitiesPanelProps) {
  const locale = useLanguage();
  const labels = locale === "zh"
    ? {
        title: "运行配置",
        subtitle: "来自 daemon 最近一次嗅探",
        model: "模型",
        reasoning: "推理强度",
        thinking: "Thinking",
        unknownRuntime: "未知运行环境",
        noDevice: "未找到此 Bot 绑定设备的 runtime 数据。",
        noSnapshot: "daemon 尚未上报 runtime snapshot。",
        unavailable: "此 runtime 当前不可用。",
        noEditable: "此 runtime 未上报可配置的模型或推理参数。",
        modelPlaceholder: "选择模型",
        reasoningPlaceholder: "选择推理强度",
        default: "默认",
        save: "保存运行配置",
        saving: "保存中",
        saved: "已保存",
        saveFailed: "保存运行配置失败",
      }
    : {
        title: "Runtime settings",
        subtitle: "From the daemon's latest probe",
        model: "Model",
        reasoning: "Reasoning effort",
        thinking: "Thinking",
        unknownRuntime: "Unknown runtime",
        noDevice: "No runtime data found for this Bot's device.",
        noSnapshot: "The daemon has not reported a runtime snapshot yet.",
        unavailable: "This runtime is currently unavailable.",
        noEditable: "This runtime did not report configurable model or reasoning parameters.",
        modelPlaceholder: "Select model",
        reasoningPlaceholder: "Select reasoning effort",
        default: "default",
        save: "Save runtime settings",
        saving: "Saving",
        saved: "Saved",
        saveFailed: "Failed to save runtime settings",
      };

  const runtime = findRuntimeForAgent(agentId, daemon, runtimeId);
  const displayRuntimeId = runtime?.id ?? runtimeId ?? null;
  const hasSnapshot = daemon?.runtimes !== null && daemon?.runtimes !== undefined;
  const canShowCapabilities = !!runtime && runtime.available !== false;
  const models = runtime?.models ?? [];

  const initialModelId = useMemo(
    () => resolveModelId(runtime, runtimeModel),
    [runtime, runtimeModel],
  );
  const [selectedModelId, setSelectedModelId] = useState<string | null>(initialModelId);

  useEffect(() => {
    setSelectedModelId(initialModelId);
  }, [initialModelId]);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );
  const reasoningParam = useMemo(
    () => findRuntimeParameter(runtime, selectedModel, REASONING_PARAM_IDS),
    [runtime, selectedModel],
  );
  const thinkingParam = useMemo(
    () => findRuntimeParameter(runtime, selectedModel, THINKING_PARAM_IDS),
    [runtime, selectedModel],
  );
  const reasoningValues = reasoningParam?.values?.map(parameterValueKey) ?? [];
  const hasReasoning =
    !!reasoningParam &&
    (reasoningValues.length > 0 || reasoningParam.type === "string");
  const hasThinking = thinkingParam?.type === "boolean";

  const initialReasoningValue = useMemo(
    () => resolveReasoningValue(reasoningParam, reasoningEffort),
    [reasoningParam, reasoningEffort],
  );
  const initialThinkingValue = useMemo(
    () => resolveThinkingValue(thinkingParam, thinking),
    [thinkingParam, thinking],
  );

  const [selectedReasoning, setSelectedReasoning] = useState<string | null>(initialReasoningValue);
  const [selectedThinking, setSelectedThinking] = useState<boolean | null>(initialThinkingValue);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedReasoning(initialReasoningValue);
  }, [initialReasoningValue]);

  useEffect(() => {
    setSelectedThinking(initialThinkingValue);
  }, [initialThinkingValue]);

  const modelOptions = useMemo(
    () =>
      models.map((model) => ({
        value: model.id,
        label: modelLabel(model),
        sublabel: [
          model.provider,
          model.isDefault ? labels.default : null,
          model.source,
        ].filter(Boolean).join(" · "),
      })),
    [models, labels.default],
  );

  const dirty =
    canShowCapabilities &&
    (
      (models.length > 0 && selectedModelId !== initialModelId) ||
      (hasReasoning && selectedReasoning !== initialReasoningValue) ||
      (hasThinking && selectedThinking !== initialThinkingValue)
    );
  const hasEditableFields = models.length > 0 || hasReasoning || hasThinking;

  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await userApi.updateAgent(agentId, {
        ...(models.length > 0 ? { runtime_model: selectedModelId } : {}),
        ...(hasReasoning ? { reasoning_effort: selectedReasoning } : {}),
        ...(hasThinking ? { thinking: selectedThinking } : {}),
      });
      await onSaved?.();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : labels.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`rounded-2xl border border-glass-border bg-glass-bg/30 p-4 ${className ?? ""}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Cpu className="h-4 w-4 text-neon-cyan" />
            {labels.title}
          </div>
          <p className="mt-0.5 text-xs text-text-secondary/60">{labels.subtitle}</p>
        </div>
        <Chip title={displayRuntimeId ?? labels.unknownRuntime} tone="cyan">
          <Bot className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{displayRuntimeId ?? labels.unknownRuntime}</span>
        </Chip>
      </div>

      <div className="space-y-4">
        {!daemon ? (
          <EmptyText>{labels.noDevice}</EmptyText>
        ) : !hasSnapshot ? (
          <EmptyText>{labels.noSnapshot}</EmptyText>
        ) : !runtime ? (
          <EmptyText>{labels.noDevice}</EmptyText>
        ) : runtime.available === false ? (
          <EmptyText>{runtime.error || labels.unavailable}</EmptyText>
        ) : canShowCapabilities && !hasEditableFields ? (
          <EmptyText>{labels.noEditable}</EmptyText>
        ) : null}

        {canShowCapabilities && hasEditableFields ? (
          <>
            {models.length > 0 ? (
              <FieldRow label={labels.model}>
                <DashboardSelect
                  disabled={saving}
                  value={selectedModelId}
                  onChange={setSelectedModelId}
                  placeholder={labels.modelPlaceholder}
                  options={modelOptions}
                  leadingIcon={<Bot className="h-4 w-4 text-neon-cyan" />}
                />
              </FieldRow>
            ) : null}

            {hasReasoning ? (
              <FieldRow label={labels.reasoning}>
                {reasoningValues.length > 0 ? (
                  <DashboardSelect
                    disabled={saving}
                    value={selectedReasoning}
                    onChange={setSelectedReasoning}
                    placeholder={labels.reasoningPlaceholder}
                    options={reasoningValues.map((value) => ({
                      value,
                      label: value,
                      sublabel:
                        reasoningParam?.defaultValue !== undefined &&
                        parameterValueKey(reasoningParam.defaultValue) === value
                          ? labels.default
                          : undefined,
                    }))}
                    leadingIcon={<Brain className="h-4 w-4 text-neon-cyan" />}
                  />
                ) : (
                  <div className="flex min-h-10 items-center gap-2 rounded-xl border border-glass-border bg-deep-black px-3">
                    <Brain className="h-4 w-4 shrink-0 text-neon-cyan" />
                    <input
                      disabled={saving}
                      type="text"
                      value={selectedReasoning ?? ""}
                      placeholder={labels.reasoningPlaceholder}
                      onChange={(event) => setSelectedReasoning(event.target.value.trim() || null)}
                      className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary/60 disabled:opacity-50"
                    />
                  </div>
                )}
              </FieldRow>
            ) : null}

            {hasThinking ? (
              <FieldRow label={labels.thinking}>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setSelectedThinking((value) => value !== true)}
                  className="flex min-h-10 w-full items-center justify-between gap-3 rounded-xl border border-glass-border bg-deep-black px-3 text-sm text-text-primary transition-colors hover:border-neon-cyan/45 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-neon-cyan" />
                    {labels.thinking}
                  </span>
                  <span
                    className={`flex h-5 w-9 items-center rounded-full border px-0.5 transition-colors ${
                      selectedThinking === true
                        ? "justify-end border-neon-cyan/40 bg-neon-cyan/20"
                        : "justify-start border-glass-border bg-glass-bg"
                    }`}
                  >
                    <span className="h-3.5 w-3.5 rounded-full bg-text-primary" />
                  </span>
                </button>
              </FieldRow>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <div className="min-h-4 text-xs">
                {error ? (
                  <span className="text-red-300">{error}</span>
                ) : saved ? (
                  <span className="inline-flex items-center gap-1 text-neon-green">
                    <Check className="h-3 w-3" />
                    {labels.saved}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={() => void handleSave()}
                className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {saving ? labels.saving : labels.save}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
