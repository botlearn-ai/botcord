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
} from "./database.js";
import { assertAgentRegistered } from "./hub-state.js";

type SyncAssertionFn = (inst: InstanceState, evidence: InstanceEvidence, env: EnvironmentConfig) => AssertionResult;
type AsyncAssertionFn = (inst: InstanceState, evidence: InstanceEvidence, env: EnvironmentConfig) => Promise<AssertionResult>;

// Map assertion IDs to their implementation functions
const ASSERTION_REGISTRY: Record<string, SyncAssertionFn | AsyncAssertionFn> = {
  "agent_output.status_ok": (inst, ev) => assertStatusOk(inst, ev),
  "agent_output.payload_non_empty": (inst, ev) => assertPayloadNonEmpty(inst, ev),
  "plugin.install_present": (inst, ev) => assertPluginInstallPresent(inst, ev),
  "openclaw_config.botcord_enabled": (inst, ev) => assertBotcordEnabled(inst, ev),
  "openclaw_config.credentials_file_exists": (inst, ev) => assertCredentialsFileExists(inst, ev),
  "openclaw_config.delivery_mode_set": (inst, ev) => assertDeliveryModeSet(inst, ev),
  "credentials.valid_json": (inst, ev) => assertCredentialsValidJson(inst, ev),
  "credentials.has_agent_id": (inst, ev) => assertCredentialsHasAgentId(inst, ev),
  "credentials.hub_matches_environment": (inst, ev, env) => assertCredentialsHubMatchesEnv(inst, ev, env),
  "db.agent_exists": (inst, ev, env) => assertAgentExists(inst, ev, env),
  "db.signing_key_active": (inst, ev, env) => assertSigningKeyActive(inst, ev, env),
  "db.claim_code_present": (inst, ev, env) => assertClaimCodePresent(inst, ev, env),
  "hub.agent_registered": (inst, ev, env) => assertAgentRegistered(inst, ev, env),
  "healthcheck.connection_ok": (inst, ev) => assertHealthcheckOk(inst, ev),
  "restart.credentials_persist": (inst, ev) => assertCredentialsPersistAfterRestart(inst, ev),
  "restart.healthcheck_ok": (inst, ev) => assertRestartHealthcheckOk(inst, ev),
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
