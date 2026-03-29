import type {
  ScenarioConfig,
  EnvironmentConfig,
  InstanceState,
  InstanceEvidence,
  AssertionResult,
} from "../types.js";
import {
  assertStatusOk,
  assertPayloadNonEmpty,
  assertHealthcheckOk,
  assertRestartHealthcheckOk,
} from "./agent-output.js";
import {
  assertPluginInstallPresent,
  assertBotcordEnabled,
  assertCredentialsFileExists,
  assertDeliveryModeSet,
  assertCredentialsValidJson,
  assertCredentialsHasAgentId,
  assertCredentialsHubMatchesEnv,
  assertCredentialsPersistAfterRestart,
} from "./filesystem.js";
import {
  assertAgentExists,
  assertSigningKeyActive,
  assertClaimCodePresent,
  assertAgentNotBound,
  assertRoomExists,
  assertRoomCreatorIsMember,
  assertRoomMemberExists,
  assertContactRelationshipExists,
} from "./database.js";
import { assertAgentRegistered, assertClaimUrlAccessible } from "./hub-state.js";
import {
  assertContainersHealthy,
  assertNoFatalErrors,
  assertModelConfigured,
} from "./runtime.js";
import {
  assertAgentIdUnchanged,
  assertAgentIdChanged,
} from "./identity.js";
import {
  assertRoomIdExtracted,
  assertJoinSucceeded,
  assertInviteCodeExtracted,
  assertInviteJoinSucceeded,
  assertVisibilitySet,
  assertJoinPolicySet,
  assertPaidPromptMentionsSubscription,
} from "./room.js";
import {
  assertFriendInviteCreated,
  assertFriendInviteAccepted,
  assertInviteCodeValid,
  assertShareUrlMatchesEnvironment,
} from "./social.js";

type SyncAssertionFn = (inst: InstanceState, evidence: InstanceEvidence, env: EnvironmentConfig) => AssertionResult;
type AsyncAssertionFn = (inst: InstanceState, evidence: InstanceEvidence, env: EnvironmentConfig) => Promise<AssertionResult>;

// Map assertion IDs to their implementation functions
const ASSERTION_REGISTRY: Record<string, SyncAssertionFn | AsyncAssertionFn> = {
  // ── Agent output ────────────────────────────────────────────────
  "agent_output.status_ok": (inst, ev) => assertStatusOk(inst, ev),
  "agent_output.payload_non_empty": (inst, ev) => assertPayloadNonEmpty(inst, ev),

  // ── Plugin & filesystem ─────────────────────────────────────────
  "plugin.install_present": (inst, ev) => assertPluginInstallPresent(inst, ev),
  "openclaw_config.botcord_enabled": (inst, ev) => assertBotcordEnabled(inst, ev),
  "openclaw_config.credentials_file_exists": (inst, ev) => assertCredentialsFileExists(inst, ev),
  "openclaw_config.delivery_mode_set": (inst, ev) => assertDeliveryModeSet(inst, ev),
  "credentials.valid_json": (inst, ev) => assertCredentialsValidJson(inst, ev),
  "credentials.has_agent_id": (inst, ev) => assertCredentialsHasAgentId(inst, ev),
  "credentials.hub_matches_environment": (inst, ev, env) => assertCredentialsHubMatchesEnv(inst, ev, env),

  // ── Runtime ─────────────────────────────────────────────────────
  "runtime.containers_healthy": (inst, ev) => assertContainersHealthy(inst, ev),
  "runtime.no_fatal_errors": (inst, ev) => assertNoFatalErrors(inst, ev),
  "openclaw_config.model_configured": (inst, ev) => assertModelConfigured(inst, ev),

  // ── Identity ────────────────────────────────────────────────────
  "identity.agent_id_unchanged": (inst, ev) => assertAgentIdUnchanged(inst, ev),
  "identity.agent_id_changed": (inst, ev) => assertAgentIdChanged(inst, ev),

  // ── Database ────────────────────────────────────────────────────
  "db.agent_exists": (inst, ev, env) => assertAgentExists(inst, ev, env),
  "db.signing_key_active": (inst, ev, env) => assertSigningKeyActive(inst, ev, env),
  "db.claim_code_present": (inst, ev, env) => assertClaimCodePresent(inst, ev, env),
  "db.agent_not_bound": (inst, ev, env) => assertAgentNotBound(inst, ev, env),
  "db.room_exists": (inst, ev, env) => assertRoomExists(inst, ev, env),
  "db.room_creator_is_member": (inst, ev, env) => assertRoomCreatorIsMember(inst, ev, env),
  "db.room_member_exists": (inst, ev, env) => assertRoomMemberExists(inst, ev, env),
  "db.contact_relationship_exists": (inst, ev, env) => assertContactRelationshipExists(inst, ev, env),

  // ── Hub API ─────────────────────────────────────────────────────
  "hub.agent_registered": (inst, ev, env) => assertAgentRegistered(inst, ev, env),
  "hub.claim_url_accessible": (inst, ev, env) => assertClaimUrlAccessible(inst, ev, env),

  // ── Healthcheck & restart ───────────────────────────────────────
  "healthcheck.connection_ok": (inst, ev) => assertHealthcheckOk(inst, ev),
  "restart.credentials_persist": (inst, ev) => assertCredentialsPersistAfterRestart(inst, ev),
  "restart.healthcheck_ok": (inst, ev) => assertRestartHealthcheckOk(inst, ev),

  // ── Room ────────────────────────────────────────────────────────
  "room.id_extracted": (inst, ev) => assertRoomIdExtracted(inst, ev),
  "room.join_succeeded": (inst, ev) => assertJoinSucceeded(inst, ev),
  "room.invite_code_extracted": (inst, ev) => assertInviteCodeExtracted(inst, ev),
  "room.invite_join_succeeded": (inst, ev) => assertInviteJoinSucceeded(inst, ev),
  "room.visibility_set": (inst, ev) => assertVisibilitySet(inst, ev),
  "room.join_policy_set": (inst, ev) => assertJoinPolicySet(inst, ev),
  "room.paid_prompt_mentions_subscription": (inst, ev) => assertPaidPromptMentionsSubscription(inst, ev),

  // ── Social / sharing ────────────────────────────────────────────
  "share.invite_code_valid": (inst, ev, env) => assertInviteCodeValid(inst, ev, env),
  "share.url_matches_environment": (inst, ev, env) => assertShareUrlMatchesEnvironment(inst, ev, env),
  "friend.invite_created": (inst, ev) => assertFriendInviteCreated(inst, ev),
  "friend.invite_accepted": (inst, ev) => assertFriendInviteAccepted(inst, ev),
};

/**
 * Run all assertions defined in the scenario for a given instance.
 */
export async function runAssertions(
  scenario: ScenarioConfig,
  env: EnvironmentConfig,
  instance: InstanceState,
  evidence: InstanceEvidence,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const assertionDef of scenario.assertions) {
    const fn = ASSERTION_REGISTRY[assertionDef.id];
    if (!fn) {
      results.push({
        id: assertionDef.id,
        instanceId: instance.id,
        status: "error",
        expected: null,
        actual: null,
        error: `No assertion implementation for "${assertionDef.id}"`,
      });
      continue;
    }

    try {
      const result = await fn(instance, evidence, env);
      results.push(result);
    } catch (err) {
      results.push({
        id: assertionDef.id,
        instanceId: instance.id,
        status: "error",
        expected: null,
        actual: null,
        error: String(err),
      });
    }
  }

  return results;
}
