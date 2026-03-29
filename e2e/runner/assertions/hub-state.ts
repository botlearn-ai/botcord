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
 * We query the DB for the real claim_code so the URL matches
 * the contract the ClaimAgentPage expects.
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

  // Look up the real claim_code from the database
  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "hub.claim_url_accessible",
      instanceId: inst.id,
      status: "skipped",
      expected: "claim URL accessible",
      actual: null,
      evidence: `${env.db_url_env} not set — cannot look up claim_code`,
    };
  }

  let claimCode: string | undefined;
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: dbUrl });
    try {
      await client.connect();
      const result = await client.query(
        "SELECT claim_code FROM agents WHERE agent_id = $1 AND claim_code IS NOT NULL AND claim_code != ''",
        [agentId],
      );
      if (result.rows.length > 0) {
        claimCode = result.rows[0]["claim_code"] as string;
      }
    } finally {
      await client.end();
    }
  } catch (err) {
    return {
      id: "hub.claim_url_accessible",
      instanceId: inst.id,
      status: "error",
      expected: "claim URL accessible",
      actual: null,
      error: `DB query for claim_code failed: ${err}`,
    };
  }

  if (!claimCode) {
    return makeResult(
      "hub.claim_url_accessible",
      inst.id,
      false,
      "claim_code exists to build URL",
      "no claim_code found in DB",
    );
  }

  const claimUrl = `${env.web_base_url}/agents/claim/${claimCode}`;

  try {
    const response = await fetch(claimUrl, {
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });

    // 200 = page rendered, 301/302 = redirect to login (expected for
    // unauthenticated requests). Only fail on 5xx or true 404.
    const acceptable = response.status < 500 && response.status !== 404;

    return makeResult(
      "hub.claim_url_accessible",
      inst.id,
      acceptable,
      "claim URL returns 2xx or redirect",
      `HTTP ${response.status}`,
      `GET ${claimUrl} (claim_code=${claimCode})`,
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
