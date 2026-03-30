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
 * Assert that a friend invite was created successfully.
 */
export function assertFriendInviteCreated(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const result = evidence.agentResults["create_friend_invite"];
  if (!result) {
    return {
      id: "friend.invite_created",
      instanceId: inst.id,
      status: "skipped",
      expected: "invite created",
      actual: null,
      evidence: "No create_friend_invite step result",
    };
  }

  const output = (result.text ?? result.raw).toLowerCase();
  const succeeded = result.exitCode === 0 && (
    output.includes("invite") ||
    output.includes("friend") ||
    output.includes("link") ||
    output.includes("code") ||
    output.includes("success")
  );

  return makeResult(
    "friend.invite_created",
    inst.id,
    succeeded,
    "friend invite created",
    `exitCode=${result.exitCode}`,
    output.slice(0, 500),
  );
}

/**
 * Assert that a friend invite was accepted successfully.
 */
export function assertFriendInviteAccepted(
  inst: InstanceState,
  evidence: InstanceEvidence,
): AssertionResult {
  const result = evidence.agentResults["accept_friend_invite"];
  if (!result) {
    return {
      id: "friend.invite_accepted",
      instanceId: inst.id,
      status: "skipped",
      expected: "invite accepted",
      actual: null,
      evidence: "No accept_friend_invite step result",
    };
  }

  const output = (result.text ?? result.raw).toLowerCase();
  const succeeded = result.exitCode === 0 && (
    output.includes("accept") ||
    output.includes("friend") ||
    output.includes("contact") ||
    output.includes("success") ||
    output.includes("added")
  );

  return makeResult(
    "friend.invite_accepted",
    inst.id,
    succeeded,
    "friend invite accepted",
    `exitCode=${result.exitCode}`,
    output.slice(0, 500),
  );
}

/**
 * Assert that a share/invite code can be validated via Hub API.
 */
export async function assertInviteCodeValid(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const code = evidence.inviteCode ?? evidence.shareId;
  if (!code) {
    return {
      id: "share.invite_code_valid",
      instanceId: inst.id,
      status: "skipped",
      expected: "invite code queryable",
      actual: null,
      evidence: "No invite code or share ID extracted",
    };
  }

  try {
    // Try to query the invite preview endpoint
    const url = `${env.hub_base_url}/invites/${code}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return makeResult(
        "share.invite_code_valid",
        inst.id,
        true,
        "invite code queryable",
        `HTTP ${response.status}`,
        `GET ${url}`,
      );
    }

    // Also try the web URL pattern
    const webUrl = `${env.web_base_url}/invites/${code}`;
    const webResponse = await fetch(webUrl, {
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });

    const webOk = webResponse.ok || webResponse.status === 301 || webResponse.status === 302;
    return makeResult(
      "share.invite_code_valid",
      inst.id,
      webOk,
      "invite code queryable via web or API",
      `API: ${response.status}, Web: ${webResponse.status}`,
      `Tried ${url} and ${webUrl}`,
    );
  } catch (err) {
    return {
      id: "share.invite_code_valid",
      instanceId: inst.id,
      status: "error",
      expected: "invite code queryable",
      actual: null,
      error: String(err),
    };
  }
}

/**
 * Assert that share/invite URLs match the target environment.
 */
export function assertShareUrlMatchesEnvironment(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): AssertionResult {
  // Check agent output from generate_share step for URLs
  const result = evidence.agentResults["generate_share"] ?? evidence.agentResults["generate_invite"];
  if (!result) {
    return {
      id: "share.url_matches_environment",
      instanceId: inst.id,
      status: "skipped",
      expected: "URLs match environment",
      actual: null,
      evidence: "No share generation step result",
    };
  }

  const output = result.text ?? result.raw;
  // Extract URLs from output
  const urlPattern = /https?:\/\/[^\s"'<>]+/g;
  const urls = output.match(urlPattern) ?? [];

  if (urls.length === 0) {
    return makeResult(
      "share.url_matches_environment",
      inst.id,
      false,
      "URLs referencing environment",
      "no URLs found in output",
      output.slice(0, 300),
    );
  }

  // Check that URLs reference the correct environment
  const envHostname = new URL(env.web_base_url).hostname;
  const hubHostname = new URL(env.hub_base_url).hostname;
  const matchesEnv = urls.some(
    url => url.includes(envHostname) || url.includes(hubHostname),
  );

  return makeResult(
    "share.url_matches_environment",
    inst.id,
    matchesEnv,
    `URLs reference ${envHostname} or ${hubHostname}`,
    matchesEnv ? "match" : `URLs found: ${urls.slice(0, 3).join(", ")}`,
    output.slice(0, 300),
  );
}
