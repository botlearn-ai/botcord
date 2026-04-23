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

export async function assertAgentNotBound(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  if (!agentId) {
    return {
      id: "db.agent_not_bound",
      instanceId: inst.id,
      status: "skipped",
      expected: "agent not bound",
      actual: null,
      evidence: "No agentId in credentials",
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.agent_not_bound",
      instanceId: inst.id,
      status: "skipped",
      expected: "agent not bound",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    const rows = await queryDb(
      env,
      "SELECT agent_id, user_id FROM agents WHERE agent_id = $1",
      [agentId],
    );
    if (rows.length === 0) {
      return makeResult(
        "db.agent_not_bound",
        inst.id,
        false,
        "agent exists with user_id IS NULL",
        "agent not found in DB",
      );
    }
    const userId = rows[0]["user_id"];
    const notBound = userId === null || userId === undefined;
    return makeResult(
      "db.agent_not_bound",
      inst.id,
      notBound,
      "user_id IS NULL (unbound)",
      userId === null || userId === undefined ? "NULL" : String(userId),
      `Agent ${agentId} user_id = ${userId ?? "NULL"}`,
    );
  } catch (err) {
    return {
      id: "db.agent_not_bound",
      instanceId: inst.id,
      status: "error",
      expected: "agent not bound",
      actual: null,
      error: String(err),
    };
  }
}

export async function assertRoomExists(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const roomId = evidence.roomId ?? evidence.peerRoomId;
  if (!roomId) {
    return {
      id: "db.room_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "room row in DB",
      actual: null,
      evidence: "No roomId available",
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.room_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "room row in DB",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    const rows = await queryDb(env, "SELECT room_id, name, visibility, join_policy, created_at FROM rooms WHERE room_id = $1", [roomId]);
    const exists = rows.length > 0;
    if (exists) {
      // Store room details for other assertions
      evidence.roomDetails = rows[0];
    }
    return makeResult(
      "db.room_exists",
      inst.id,
      exists,
      "room row exists",
      exists ? `found: ${JSON.stringify(rows[0])}` : "not found",
      `Queried rooms WHERE room_id = '${roomId}'`,
    );
  } catch (err) {
    return {
      id: "db.room_exists",
      instanceId: inst.id,
      status: "error",
      expected: "room row in DB",
      actual: null,
      error: String(err),
    };
  }
}

export async function assertRoomCreatorIsMember(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const roomId = evidence.roomId;
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  if (!roomId || !agentId) {
    return {
      id: "db.room_creator_is_member",
      instanceId: inst.id,
      status: "skipped",
      expected: "creator is member",
      actual: null,
      evidence: `roomId=${roomId ?? "missing"}, agentId=${agentId ?? "missing"}`,
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.room_creator_is_member",
      instanceId: inst.id,
      status: "skipped",
      expected: "creator is member",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    const rows = await queryDb(
      env,
      "SELECT agent_id, role FROM room_members WHERE room_id = $1 AND agent_id = $2",
      [roomId, agentId],
    );
    const isMember = rows.length > 0;
    return makeResult(
      "db.room_creator_is_member",
      inst.id,
      isMember,
      "creator is a room member",
      isMember ? `role: ${rows[0]["role"]}` : "not a member",
    );
  } catch (err) {
    return {
      id: "db.room_creator_is_member",
      instanceId: inst.id,
      status: "error",
      expected: "creator is member",
      actual: null,
      error: String(err),
    };
  }
}

export async function assertRoomMemberExists(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const roomId = evidence.roomId ?? evidence.peerRoomId;
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  if (!roomId || !agentId) {
    return {
      id: "db.room_member_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "agent is member",
      actual: null,
      evidence: `roomId=${roomId ?? "missing"}, agentId=${agentId ?? "missing"}`,
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.room_member_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "agent is member",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    const rows = await queryDb(
      env,
      "SELECT agent_id, role FROM room_members WHERE room_id = $1 AND agent_id = $2",
      [roomId, agentId],
    );
    const isMember = rows.length > 0;
    return makeResult(
      "db.room_member_exists",
      inst.id,
      isMember,
      "agent is a room member",
      isMember ? `role: ${rows[0]["role"]}` : "not a member",
      `Queried room_members WHERE room_id='${roomId}' AND agent_id='${agentId}'`,
    );
  } catch (err) {
    return {
      id: "db.room_member_exists",
      instanceId: inst.id,
      status: "error",
      expected: "agent is member",
      actual: null,
      error: String(err),
    };
  }
}

export async function assertContactRelationshipExists(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.credentials?.["agentId"] as string | undefined;
  const peerId = evidence.peerAgentId;
  if (!agentId || !peerId) {
    return {
      id: "db.contact_relationship_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "contact relationship",
      actual: null,
      evidence: `agentId=${agentId ?? "missing"}, peerId=${peerId ?? "missing"}`,
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.contact_relationship_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "contact relationship",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    // Check contacts table for relationship in either direction
    const rows = await queryDb(
      env,
      "SELECT owner_agent_id, contact_agent_id FROM contacts WHERE (owner_agent_id = $1 AND contact_agent_id = $2) OR (owner_agent_id = $2 AND contact_agent_id = $1)",
      [agentId, peerId],
    );
    const exists = rows.length > 0;
    return makeResult(
      "db.contact_relationship_exists",
      inst.id,
      exists,
      "contact relationship exists",
      exists ? `found ${rows.length} relationship(s)` : "no contact relationship",
      `Queried contacts for ${agentId} <-> ${peerId}`,
    );
  } catch (err) {
    return {
      id: "db.contact_relationship_exists",
      instanceId: inst.id,
      status: "error",
      expected: "contact relationship",
      actual: null,
      error: String(err),
    };
  }
}

export async function assertApprovalQueueEntryExists(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.peerAgentId ?? evidence.credentials?.["agentId"] as string | undefined;
  if (!agentId) {
    return {
      id: "db.approval_queue_entry_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "approval queue entry",
      actual: null,
      evidence: "No agentId available to query approval queue",
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.approval_queue_entry_exists",
      instanceId: inst.id,
      status: "skipped",
      expected: "approval queue entry",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    const rows = await queryDb(
      env,
      "SELECT id, agent_id, kind, state FROM agent_approval_queue WHERE agent_id = $1 AND state = 'pending' ORDER BY created_at DESC LIMIT 1",
      [agentId],
    );
    const exists = rows.length > 0;
    if (exists && !evidence.approvalId) {
      evidence.approvalId = String(rows[0]["id"]);
    }
    return makeResult(
      "db.approval_queue_entry_exists",
      inst.id,
      exists,
      "pending approval queue entry",
      exists ? `found: kind=${rows[0]["kind"]}, id=${rows[0]["id"]}` : "not found",
      `Queried agent_approval_queue WHERE agent_id='${agentId}' AND state='pending'`,
    );
  } catch (err) {
    return {
      id: "db.approval_queue_entry_exists",
      instanceId: inst.id,
      status: "error",
      expected: "approval queue entry",
      actual: null,
      error: String(err),
    };
  }
}

export async function assertContactApproved(
  inst: InstanceState,
  evidence: InstanceEvidence,
  env: EnvironmentConfig,
): Promise<AssertionResult> {
  const agentId = evidence.peerAgentId ?? evidence.credentials?.["agentId"] as string | undefined;
  const approvalId = evidence.approvalId;
  if (!agentId && !approvalId) {
    return {
      id: "db.contact_approved",
      instanceId: inst.id,
      status: "skipped",
      expected: "contact_request approved",
      actual: null,
      evidence: "No agentId or approvalId available",
    };
  }

  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    return {
      id: "db.contact_approved",
      instanceId: inst.id,
      status: "skipped",
      expected: "contact_request approved",
      actual: null,
      evidence: `${env.db_url_env} not set`,
    };
  }

  try {
    let rows: Record<string, unknown>[];
    if (approvalId) {
      rows = await queryDb(
        env,
        "SELECT id, state FROM agent_approval_queue WHERE id = $1",
        [approvalId],
      );
    } else {
      rows = await queryDb(
        env,
        "SELECT id, state FROM agent_approval_queue WHERE agent_id = $1 AND kind = 'contact_request' ORDER BY created_at DESC LIMIT 1",
        [agentId!],
      );
    }
    if (rows.length === 0) {
      return makeResult("db.contact_approved", inst.id, false, "approved state", "entry not found");
    }
    const approved = rows[0]["state"] === "approved";
    return makeResult(
      "db.contact_approved",
      inst.id,
      approved,
      "state = approved",
      `state = ${rows[0]["state"]}`,
      approvalId ? `id=${approvalId}` : `agent=${agentId}`,
    );
  } catch (err) {
    return {
      id: "db.contact_approved",
      instanceId: inst.id,
      status: "error",
      expected: "contact_request approved",
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
