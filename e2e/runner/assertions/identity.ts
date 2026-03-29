import type { AssertionResult, InstanceEvidence, InstanceState } from "../types.js";

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
 * Assert that the current agent ID matches the backed-up agent ID.
 * Used after reset or link operations to verify identity is preserved.
 */
export function assertAgentIdUnchanged(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const currentId = evidence.credentials?.["agentId"] as string | undefined;
  const backupId = evidence.credentialsBackup?.["agentId"] as string | undefined;

  if (!backupId) {
    return {
      id: "identity.agent_id_unchanged",
      instanceId: inst.id,
      status: "skipped",
      expected: "agent ID unchanged",
      actual: null,
      evidence: "No credentials backup available for comparison",
    };
  }

  if (!currentId) {
    return makeResult(
      "identity.agent_id_unchanged",
      inst.id,
      false,
      `same as backup: ${backupId}`,
      "no current agentId",
    );
  }

  return makeResult(
    "identity.agent_id_unchanged",
    inst.id,
    currentId === backupId,
    `same as backup: ${backupId}`,
    currentId,
    currentId === backupId ? "identity preserved" : "IDENTITY CHANGED",
  );
}

/**
 * Assert that the current agent ID is DIFFERENT from the backed-up agent ID.
 * Used after explicit create-new-bot to verify a new identity was created.
 */
export function assertAgentIdChanged(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const currentId = evidence.credentials?.["agentId"] as string | undefined;
  const backupId = evidence.credentialsBackup?.["agentId"] as string | undefined;

  if (!backupId) {
    return {
      id: "identity.agent_id_changed",
      instanceId: inst.id,
      status: "skipped",
      expected: "different agent ID",
      actual: null,
      evidence: "No credentials backup available for comparison",
    };
  }

  if (!currentId) {
    return makeResult(
      "identity.agent_id_changed",
      inst.id,
      false,
      `different from backup: ${backupId}`,
      "no current agentId",
    );
  }

  return makeResult(
    "identity.agent_id_changed",
    inst.id,
    currentId !== backupId,
    `different from backup: ${backupId}`,
    currentId,
    currentId !== backupId ? "new identity created" : "SAME IDENTITY (expected different)",
  );
}
