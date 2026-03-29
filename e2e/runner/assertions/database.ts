import type { AssertionResult, InstanceEvidence, InstanceState, EnvironmentConfig } from "../types.js";

/**
 * Query the database for agent registration info.
 * Uses the pg module to connect to the environment's database.
 */
async function queryDb(env: EnvironmentConfig, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    throw new Error(`Database URL not set: ${env.db_url_env}`);
  }
  // Dynamic import to avoid requiring pg when DB assertions are skipped
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: dbUrl });
  try {
    await client.connect();
    const result = await client.query(sql, params);
    return result.rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

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

export async function assertAgentExists(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  if (!agentId) {
    return {
      id: "db.agent_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "agent row in DB",
      actual: null,
      evidence: "No agentId in credentials — cannot query DB",
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.agent_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "agent row in DB",
      actual: null,
      evidence: `${env.db_url_env} not set — skipping DB assertion`,
    };
  }

  try {
    const rows = await queryDb(env, "SELECT agent_id, display_name, created_at FROM agents WHERE agent_id = $1", [agentId]);
    const exists = rows.length > 0;
    return makeResult(
      "db.agent_exists",
      inst.id,
      exists,
      "agent row exists",
      exists ? `found: ${JSON.stringify(rows[0])}` : "not found",
      `Queried agents WHERE agent_id = '${agentId}'`,
    );
  } catch (err) {
    return {
      id: "db.agent_exists",
      instanceId: inst.id,
      status: "error",
      expected: "agent row in DB",
      actual: null,
      error: String(err),
    };
  }
}

export async function assertSigningKeyActive(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  if (!agentId) {
    return {
      id: "db.signing_key_active",
      instanceId: inst.id,
      status: "skipped",
      expected: "active signing key",
      actual: null,
      evidence: "No agentId in credentials",
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.signing_key_active",
      instanceId: inst.id,
      status: "skipped",
      expected: "active signing key",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    const rows = await queryDb(
      env,
      "SELECT key_id, state, created_at FROM signing_keys WHERE agent_id = $1 AND state = 'active'",
      [agentId],
    );
    const hasActive = rows.length > 0;
    return makeResult(
      "db.signing_key_active",
      inst.id,
      hasActive,
      "at least 1 active signing key",
      `found ${rows.length} active key(s)`,
      hasActive ? `key: ${JSON.stringify(rows[0])}` : undefined,
    );
  } catch (err) {
    return {
      id: "db.signing_key_active",
      instanceId: inst.id,
      status: "error",
      expected: "active signing key",
      actual: null,
      error: String(err),
    };
  }
}

export async function assertClaimCodePresent(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  if (!agentId) {
    return {
      id: "db.claim_code_present",
      instanceId: inst.id,
      status: "skipped",
      expected: "claim code",
      actual: null,
      evidence: "No agentId in credentials",
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.claim_code_present",
      instanceId: inst.id,
      status: "skipped",
      expected: "claim code",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    // claim_code is a column on the agents table (see backend/hub/models.py)
    const rows = await queryDb(
      env,
      "SELECT agent_id, claim_code FROM agents WHERE agent_id = $1 AND claim_code IS NOT NULL AND claim_code != ''",
      [agentId],
    );
    const hasClaim = rows.length > 0;
    return makeResult(
      "db.claim_code_present",
      inst.id,
      hasClaim,
      "claim code exists",
      hasClaim ? `found: ${JSON.stringify(rows[0]).slice(0, 200)}` : "no claim_code on agents row",
    );
  } catch (err) {
    return {
      id: "db.claim_code_present",
      instanceId: inst.id,
      status: "error",
      expected: "claim code",
      actual: null,
      error: String(err),
    };
  }
}
