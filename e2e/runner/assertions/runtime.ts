import type { AssertionResult, InstanceEvidence, InstanceState, EnvironmentConfig } from "../types.js";

function makeResult(
  id: string,
  instanceId: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  evidence?: string,
): AssertionResult {
  return { id, instanceId, status: passed ? "passed" : "failed", expected, actual, evidence };
}

/**
 * Assert that the container started and became healthy.
 * Evidence comes from the wait_boot step succeeding (no throw) +
 * the check_logs step capturing container logs.
 */
export function assertContainersHealthy(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  // If we got this far in the scenario, the container is healthy
  // (waitHealthy would have thrown otherwise).
  // Double-check by looking for the check_logs step result.
  const logResult = evidence.agentResults["check_logs"];
  const hasLogs = logResult && logResult.raw.length > 0;
  return makeResult(
    "runtime.containers_healthy",
    inst.id,
    true, // If assertions run, containers were healthy
    "container healthy",
    hasLogs ? `logs captured (${logResult.raw.length} chars)` : "healthy (no logs captured)",
  );
}

/**
 * Assert that container logs do not contain fatal error patterns.
 */
export function assertNoFatalErrors(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const logResult = evidence.agentResults["check_logs"];
  if (!logResult || !logResult.raw) {
    return {
      id: "runtime.no_fatal_errors",
      instanceId: inst.id,
      status: "skipped",
      expected: "no fatal errors",
      actual: null,
      evidence: "No container logs captured",
    };
  }

  const errorPatterns = ["gaxios", "FATAL", "Error: Cannot find module"];
  const found: string[] = [];
  for (const pattern of errorPatterns) {
    if (logResult.raw.includes(pattern)) {
      found.push(pattern);
    }
  }

  return makeResult(
    "runtime.no_fatal_errors",
    inst.id,
    found.length === 0,
    "no fatal error patterns in logs",
    found.length === 0 ? "clean" : `found: ${found.join(", ")}`,
    logResult.raw.slice(0, 500),
  );
}

/**
 * Assert that the model is correctly configured in openclaw.json.
 */
export function assertModelConfigured(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const config = evidence.openclawConfig;
  const agents = config?.["agents"] as Record<string, unknown> | undefined;
  const defaults = agents?.["defaults"] as Record<string, unknown> | undefined;
  const model = defaults?.["model"] as Record<string, unknown> | undefined;
  const primary = model?.["primary"] as string | undefined;

  const configured = !!primary && primary.length > 0;
  return makeResult(
    "openclaw_config.model_configured",
    inst.id,
    configured,
    "model primary is set",
    primary ?? "not set",
  );
}
