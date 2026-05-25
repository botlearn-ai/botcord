export interface RuntimeSelectionOptions {
  runtimeModel?: string;
  reasoningEffort?: string;
  thinking?: boolean;
}

export function buildRuntimeSelectionExtraArgs(
  runtime: string | undefined,
  selection: RuntimeSelectionOptions,
): string[] {
  if (!runtime) return [];
  const out: string[] = [];
  const model = cleanString(selection.runtimeModel);
  const reasoningEffort = cleanString(selection.reasoningEffort);

  if (runtime === "claude-code") {
    if (model) out.push("--model", model);
    if (reasoningEffort) out.push("--effort", reasoningEffort);
  } else if (runtime === "codex") {
    if (model) out.push("--model", model);
    if (reasoningEffort) {
      out.push("-c", `model_reasoning_effort=${quoteCodexConfigValue(reasoningEffort)}`);
    }
  } else if (runtime === "deepseek-tui") {
    if (model) out.push("--model", model);
    if (reasoningEffort) out.push("--reasoning-effort", reasoningEffort);
  } else if (runtime === "kimi-cli") {
    if (model) out.push("--model", model);
    if (typeof selection.thinking === "boolean") {
      out.push(selection.thinking ? "--thinking" : "--no-thinking");
    }
  }

  return out;
}

export function mergeRuntimeExtraArgs(
  inherited: string[] | undefined,
  selected: string[],
): string[] | undefined {
  const out = [...(inherited ?? []), ...selected];
  return out.length ? out : undefined;
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function quoteCodexConfigValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
