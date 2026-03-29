import type { AssertionResult, InstanceEvidence, InstanceState } from "../types.js";

function makeResult(
  id: string,
  instanceId: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  evidence?: string,
): AssertionResult {
  return {
    id,
    instanceId,
    status: passed ? "passed" : "failed",
    expected,
    actual,
    evidence,
  };
}

export function assertStatusOk(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const result = evidence.agentResults["send_quickstart_prompt"];
  if (!result) {
    return { id: "agent_output.status_ok", instanceId: inst.id, status: "error", expected: "ok", actual: null, error: "No agent result for send_quickstart_prompt" };
  }
  // Require exit code 0 AND if status is present it must be "ok"
  const passed = result.exitCode === 0 && (result.status === undefined || result.status === "ok");
  return makeResult(
    "agent_output.status_ok",
    inst.id,
    passed,
    "exitCode=0 and status=ok (if present)",
    `exitCode=${result.exitCode}, status=${result.status ?? "none"}`,
    result.raw.slice(0, 500),
  );
}

export function assertPayloadNonEmpty(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const result = evidence.agentResults["send_quickstart_prompt"];
  if (!result) {
    return { id: "agent_output.payload_non_empty", instanceId: inst.id, status: "error", expected: "non-empty", actual: null, error: "No agent result" };
  }
  const hasContent = (result.text && result.text.length > 0) || (result.raw && result.raw.length > 10);
  return makeResult(
    "agent_output.payload_non_empty",
    inst.id,
    !!hasContent,
    "non-empty payload",
    `text length: ${result.text?.length ?? 0}, raw length: ${result.raw.length}`,
  );
}

export function assertHealthcheckOk(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const result = evidence.healthcheckResult;
  if (!result) {
    return { id: "healthcheck.connection_ok", instanceId: inst.id, status: "skipped", expected: "connection ok", actual: null, evidence: "No healthcheck result" };
  }
  const output = (result.text ?? result.raw).toLowerCase();
  // Look for specific healthcheck success pattern: connection status + agent ID
  const hasConnection = output.includes("connected") || output.includes("active") || output.includes("token valid");
  const hasAgentId = /ag_[a-z0-9]+/i.test(output);
  const connected = hasConnection && hasAgentId;
  return makeResult(
    "healthcheck.connection_ok",
    inst.id,
    connected,
    "Healthcheck indicates connection is active",
    output.slice(0, 500),
  );
}

export function assertRestartHealthcheckOk(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const result = evidence.restartHealthcheckResult;
  if (!result) {
    return { id: "restart.healthcheck_ok", instanceId: inst.id, status: "skipped", expected: "connection ok after restart", actual: null };
  }
  const output = (result.text ?? result.raw).toLowerCase();
  const hasConnection = output.includes("connected") || output.includes("active") || output.includes("token valid");
  const hasAgentId = /ag_[a-z0-9]+/i.test(output);
  const connected = hasConnection && hasAgentId;
  return makeResult(
    "restart.healthcheck_ok",
    inst.id,
    connected,
    "Healthcheck passes after restart",
    output.slice(0, 500),
  );
}
