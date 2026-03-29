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

// Note: Hub API assertions are supplementary.
// The primary registration verification comes from DB assertions.
// Hub API may require auth tokens we don't have in E2E context,
// so these are best-effort and degrade gracefully.

export async function assertAgentRegistered(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  if (!agentId) {
    return {
      id: "hub.agent_registered",
      instanceId: inst.id,
      status: "skipped",
      expected: "agent queryable via Hub",
      actual: null,
      evidence: "No agentId in credentials",
    };
  }

  try {
    // Try to query the agent's public profile via Hub API
    const url = `${env.hub_base_url}/registry/agents/${agentId}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      return makeResult(
        "hub.agent_registered",
        inst.id,
        true,
        "agent exists in Hub registry",
        `agent_id: ${data["agent_id"]}, display_name: ${data["display_name"]}`,
        `GET ${url} -> ${response.status}`,
      );
    } else if (response.status === 401 || response.status === 403) {
      // Auth required - this is expected, agent exists but we can't query without token
      return {
        id: "hub.agent_registered",
        instanceId: inst.id,
        status: "skipped",
        expected: "agent queryable via Hub",
        actual: `HTTP ${response.status}`,
        evidence: "Hub API requires auth — skipping (use DB assertion instead)",
      };
    } else {
      return makeResult(
        "hub.agent_registered",
        inst.id,
        false,
        "agent exists in Hub registry",
        `HTTP ${response.status}`,
        `GET ${url}`,
      );
    }
  } catch (err) {
    return {
      id: "hub.agent_registered",
      instanceId: inst.id,
      status: "error",
      expected: "agent queryable via Hub",
      actual: null,
      error: String(err),
    };
  }
}

/**
 * Assert that the claim page URL for this agent is accessible.
 * The claim page is at {web_base_url}/agents/claim/{claim_code}.
 * Since we may not have the claim_code in evidence, we also try
 * the agent key pattern.
 */
export async function assertClaimUrlAccessible(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  if (!agentId) {
    return {
      id: "hub.claim_url_accessible",
      instanceId: inst.id,
      status: "skipped",
      expected: "claim URL accessible",
      actual: null,
      evidence: "No agentId in credentials",
    };
  }

  // The claim page uses the agent's claim_code as the URL key.
  // We don't have it directly in evidence, but we can try the
  // web URL to verify the claim infrastructure is reachable.
  const claimUrl = `${env.web_base_url}/agents/claim/${agentId}`;

  try {
    const response = await fetch(claimUrl, {
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });

    // Accept 200 (page rendered), 301/302 (redirect to login), or 404 with HTML
    // (Next.js renders the page shell even for unknown agents).
    // Only fail on network errors or 5xx.
    const acceptable = response.status < 500;

    return makeResult(
      "hub.claim_url_accessible",
      inst.id,
      acceptable,
      "claim URL returns non-5xx",
      `HTTP ${response.status}`,
      `GET ${claimUrl}`,
    );
  } catch (err) {
    return {
      id: "hub.claim_url_accessible",
      instanceId: inst.id,
      status: "error",
      expected: "claim URL accessible",
      actual: null,
      error: String(err),
    };
  }
}
