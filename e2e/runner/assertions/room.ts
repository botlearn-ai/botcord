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
 * Assert that a room ID was extracted from agent output.
 */
export function assertRoomIdExtracted(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const roomId = evidence.roomId ?? evidence.peerRoomId;
  const hasId = !!roomId && roomId.startsWith("rm_");
  return makeResult(
    "room.id_extracted",
    inst.id,
    hasId,
    "room ID starting with rm_",
    roomId ?? "not extracted",
  );
}

/**
 * Assert that a join operation succeeded based on agent output.
 */
export function assertJoinSucceeded(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const result = evidence.agentResults["self_join_room"];
  if (!result) {
    return {
      id: "room.join_succeeded",
      instanceId: inst.id,
      status: "skipped",
      expected: "join success",
      actual: null,
      evidence: "No self_join_room step result",
    };
  }

  const output = (result.text ?? result.raw).toLowerCase();
  const succeeded = result.exitCode === 0 && (
    output.includes("join") ||
    output.includes("member") ||
    output.includes("success") ||
    output.includes("added")
  );

  return makeResult(
    "room.join_succeeded",
    inst.id,
    succeeded,
    "join operation succeeded",
    `exitCode=${result.exitCode}`,
    output.slice(0, 500),
  );
}

/**
 * Assert that an invite code or share ID was extracted from agent output.
 */
export function assertInviteCodeExtracted(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const code = evidence.inviteCode ?? evidence.shareId;
  const hasCode = !!code && code.length > 0;
  return makeResult(
    "room.invite_code_extracted",
    inst.id,
    hasCode,
    "invite code or share ID",
    code ?? "not extracted",
  );
}

/**
 * Assert that an invite-based join succeeded.
 */
export function assertInviteJoinSucceeded(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const result = evidence.agentResults["accept_invite"];
  if (!result) {
    return {
      id: "room.invite_join_succeeded",
      instanceId: inst.id,
      status: "skipped",
      expected: "invite join success",
      actual: null,
      evidence: "No accept_invite step result",
    };
  }

  const output = (result.text ?? result.raw).toLowerCase();
  const succeeded = result.exitCode === 0 && (
    output.includes("join") ||
    output.includes("member") ||
    output.includes("success") ||
    output.includes("accepted") ||
    output.includes("added")
  );

  return makeResult(
    "room.invite_join_succeeded",
    inst.id,
    succeeded,
    "invite join succeeded",
    `exitCode=${result.exitCode}`,
    output.slice(0, 500),
  );
}

/**
 * Assert that the room has a visibility field set.
 */
export function assertVisibilitySet(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const roomDetails = evidence.roomDetails;
  if (!roomDetails) {
    // If no room details from API, check agent output for visibility info
    const createResult = evidence.agentResults["create_room"];
    if (createResult) {
      const output = (createResult.text ?? createResult.raw).toLowerCase();
      const hasVisibility = output.includes("public") || output.includes("private") || output.includes("visibility");
      return makeResult(
        "room.visibility_set",
        inst.id,
        hasVisibility,
        "visibility field present",
        hasVisibility ? "mentioned in output" : "not found in output",
        output.slice(0, 300),
      );
    }
    return {
      id: "room.visibility_set",
      instanceId: inst.id,
      status: "skipped",
      expected: "visibility set",
      actual: null,
      evidence: "No room details available",
    };
  }

  const visibility = roomDetails["visibility"] as string | undefined;
  const valid = visibility === "public" || visibility === "private";
  return makeResult(
    "room.visibility_set",
    inst.id,
    valid,
    "public or private",
    visibility ?? "not set",
  );
}

/**
 * Assert that the room has a join policy set.
 */
export function assertJoinPolicySet(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const roomDetails = evidence.roomDetails;
  if (!roomDetails) {
    const createResult = evidence.agentResults["create_room"];
    if (createResult) {
      const output = (createResult.text ?? createResult.raw).toLowerCase();
      const hasPolicy = output.includes("open") || output.includes("invite") || output.includes("policy") || output.includes("approval");
      return makeResult(
        "room.join_policy_set",
        inst.id,
        hasPolicy,
        "join policy present",
        hasPolicy ? "mentioned in output" : "not found in output",
        output.slice(0, 300),
      );
    }
    return {
      id: "room.join_policy_set",
      instanceId: inst.id,
      status: "skipped",
      expected: "join policy set",
      actual: null,
      evidence: "No room details available",
    };
  }

  const policy = roomDetails["join_policy"] as string | undefined;
  const valid = !!policy && policy.length > 0;
  return makeResult(
    "room.join_policy_set",
    inst.id,
    valid,
    "join policy is set",
    policy ?? "not set",
  );
}

/**
 * Assert that a paid room share prompt mentions subscription/payment.
 */
export function assertPaidPromptMentionsSubscription(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const result = evidence.agentResults["generate_paid_share"];
  if (!result) {
    return {
      id: "room.paid_prompt_mentions_subscription",
      instanceId: inst.id,
      status: "skipped",
      expected: "payment/subscription mention",
      actual: null,
      evidence: "No generate_paid_share step result",
    };
  }

  const output = (result.text ?? result.raw).toLowerCase();
  const mentionsPayment = output.includes("subscri") ||
    output.includes("payment") ||
    output.includes("paid") ||
    output.includes("price") ||
    output.includes("fee");

  return makeResult(
    "room.paid_prompt_mentions_subscription",
    inst.id,
    mentionsPayment,
    "output mentions subscription/payment",
    mentionsPayment ? "found" : "not found",
    output.slice(0, 500),
  );
}
