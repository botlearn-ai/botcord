import type { AgentResult, AssertionResult, InstanceEvidence, InstanceState } from "../types.js";

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

/**
 * Collect all text from an AgentResult, checking direct text, payloads, and raw output.
 * The /botcord_healthcheck command may return structured output in various locations
 * depending on whether the LLM summarized it or returned tool results directly.
 */
function collectAllText(result: AgentResult): string {
  const parts: string[] = [];

  // Direct text field
  if (result.text) parts.push(result.text);

  // Parse payloads from JSON
  if (result.json) {
    const r = result.json["result"] as Record<string, unknown> | undefined;
    if (r) {
      const payloads = r["payloads"] as Array<Record<string, unknown>> | undefined;
      if (payloads) {
        for (const p of payloads) {
          if (p["text"]) parts.push(p["text"] as string);
        }
      }
    }
  }

  // Fall back to raw output if nothing found
  if (parts.length === 0 && result.raw) {
    parts.push(result.raw);
  }

  return parts.join("\n");
}

export function assertStatusOk(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const result = evidence.agentResults["send_quickstart_prompt"];
  if (!result) {
    return { id: "agent_output.status_ok", instanceId: inst.id, status: "error", expected: "ok", actual: null, error: "No agent result for send_quickstart_prompt" };
  }
  // openclaw agent --json returns non-zero exit codes in gateway mode even on
  // success (e.g. 255). The authoritative status is the JSON "status" field.
  // Pass if JSON status is "ok"; fail if status is present but not "ok";
  // fall back to exit code only when no JSON was parsed.
  const passed = result.status === "ok"
    || (result.status === undefined && result.exitCode === 0);
  return makeResult(
    "agent_output.status_ok",
    inst.id,
    passed,
    "JSON status=ok",
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

  // Collect all text from the result: direct text, payloads, and raw output
  const allText = collectAllText(result).toLowerCase();

  if (!allText || allText.length < 10) {
    return makeResult(
      "healthcheck.connection_ok",
      inst.id,
      false,
      "Healthcheck output with connection status",
      "empty or minimal output",
      `exitCode=${result.exitCode}, raw length=${result.raw.length}`,
    );
  }

  // The /botcord_healthcheck command outputs structured lines with [OK], [FAIL], [WARN]
  // A passing healthcheck has "[ok]" markers and no "[fail]" markers
  // Also check for natural language indicators from the LLM
  const hasOkMarkers = allText.includes("[ok]");
  const hasFailMarkers = allText.includes("[fail]");
  const hasConnectionOk = allText.includes("token refresh successful") || allText.includes("hub is reachable");
  const hasAgentId = /ag_[a-z0-9]+/i.test(allText);
  const hasNaturalOk = (allText.includes("connected") || allText.includes("active") || allText.includes("all checks passed")) && hasAgentId;

  const passed = (hasOkMarkers && !hasFailMarkers) || hasConnectionOk || hasNaturalOk;

  return makeResult(
    "healthcheck.connection_ok",
    inst.id,
    passed,
    "Healthcheck shows connection is active",
    passed ? "healthcheck passed" : `okMarkers=${hasOkMarkers}, failMarkers=${hasFailMarkers}, connectionOk=${hasConnectionOk}, naturalOk=${hasNaturalOk}`,
    allText.slice(0, 500),
  );
}

export function assertRestartHealthcheckOk(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const result = evidence.restartHealthcheckResult;
  if (!result) {
    return { id: "restart.healthcheck_ok", instanceId: inst.id, status: "skipped", expected: "connection ok after restart", actual: null };
  }

  // Collect all text from the result: direct text, payloads, and raw output
  const allText = collectAllText(result).toLowerCase();

  if (!allText || allText.length < 10) {
    return makeResult(
      "restart.healthcheck_ok",
      inst.id,
      false,
      "Healthcheck output with connection status after restart",
      "empty or minimal output",
      `exitCode=${result.exitCode}, raw length=${result.raw.length}`,
    );
  }

  const hasOkMarkers = allText.includes("[ok]");
  const hasFailMarkers = allText.includes("[fail]");
  const hasConnectionOk = allText.includes("token refresh successful") || allText.includes("hub is reachable");
  const hasAgentId = /ag_[a-z0-9]+/i.test(allText);
  const hasNaturalOk = (allText.includes("connected") || allText.includes("active") || allText.includes("all checks passed")) && hasAgentId;

  const passed = (hasOkMarkers && !hasFailMarkers) || hasConnectionOk || hasNaturalOk;

  return makeResult(
    "restart.healthcheck_ok",
    inst.id,
    passed,
    "Healthcheck passes after restart",
    passed ? "healthcheck passed" : `okMarkers=${hasOkMarkers}, failMarkers=${hasFailMarkers}, connectionOk=${hasConnectionOk}, naturalOk=${hasNaturalOk}`,
    allText.slice(0, 500),
  );
}
