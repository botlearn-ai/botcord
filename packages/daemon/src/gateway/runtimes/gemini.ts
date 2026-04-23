import {
  readCommandVersion,
  resolveCommandOnPath,
  type ProbeDeps,
} from "./probe.js";
import type {
  RuntimeAdapter,
  RuntimeProbeResult,
  RuntimeRunOptions,
  RuntimeRunResult,
} from "../types.js";

/** Resolve the Gemini CLI executable on PATH. */
export function resolveGeminiCommand(deps: ProbeDeps = {}): string | null {
  return resolveCommandOnPath("gemini", deps);
}

/** Probe whether the Gemini CLI is installed and report its version. */
export function probeGemini(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveGeminiCommand(deps);
  if (!command) return { available: false };
  return {
    available: true,
    path: command,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

/**
 * Gemini adapter stub — probe() is wired up so `botcord-daemon doctor` can report it.
 * run() is not implemented yet; routing a turn here will surface the error upstream.
 */
export class GeminiAdapter implements RuntimeAdapter {
  readonly id = "gemini" as const;

  probe(): RuntimeProbeResult {
    return probeGemini();
  }

  async run(_opts: RuntimeRunOptions): Promise<RuntimeRunResult> {
    throw new Error("gemini adapter not implemented");
  }
}
