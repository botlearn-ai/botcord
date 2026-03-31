import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ScenarioConfig,
  EnvironmentConfig,
  InstanceState,
  InstanceEvidence,
  InstanceRunResult,
  RunReport,
  AssertionResult,
  AgentResult,
} from "./types.js";
import { getEnvironment } from "./environment.js";
import { OpenClawRuntime } from "./openclaw-runtime.js";
import { resolvePrompt, resolvePromptByKind } from "./prompt-source.js";
import { runAssertions } from "./assertions/index.js";
import { readdir, readFile as readFileFs } from "node:fs/promises";

const CONFIG_DIR = resolve(import.meta.dirname, "../config");
const ARTIFACTS_DIR = resolve(import.meta.dirname, "../artifacts");

export async function loadScenario(scenarioName: string): Promise<ScenarioConfig> {
  const filePath = resolve(CONFIG_DIR, "scenarios", `${scenarioName}.yaml`);
  const content = await readFile(filePath, "utf-8");
  return parseYaml(content) as ScenarioConfig;
}

function generateRunId(scenario: string, envName: string): string {
  const ts = new Date().toISOString().replace(/[:-]/g, "").replace(/\..+/, "Z");
  return `${ts}-${scenario}-${envName}`;
}

export async function runScenario(
  scenarioName: string,
  envName: string,
): Promise<RunReport> {
  const startTime = new Date().toISOString();
  console.log(`\n=== E2E Scenario: ${scenarioName} | Environment: ${envName} ===\n`);

  // 1. Load configs
  const scenario = await loadScenario(scenarioName);
  const env = await getEnvironment(envName);
  const runId = generateRunId(scenario.id, envName);
  const runDir = resolve(ARTIFACTS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  console.log(`Run ID: ${runId}`);
  console.log(`Artifacts: ${runDir}`);

  // Save config snapshots
  await writeFile(resolve(runDir, "scenario.json"), JSON.stringify(scenario, null, 2));
  await writeFile(resolve(runDir, "environment.json"), JSON.stringify({ name: envName, ...env }, null, 2));

  // 2. Check mutation safety
  if (!env.allow_mutation) {
    // For now, quickstart always mutates (installs plugin, registers)
    // In the future, read-only scenarios can bypass this check
    console.warn(`\n⚠  Environment "${envName}" has allow_mutation=false.`);
    console.warn("   This scenario requires mutation (install + register). Aborting.\n");
    return {
      runId,
      scenario: scenario.id,
      environment: envName,
      startTime,
      endTime: new Date().toISOString(),
      status: "error",
      instances: [],
    };
  }

  // 3. Clean up previous E2E data
  console.log("Cleaning up previous E2E data...");
  await cleanupE2EData(env);

  // 4. Initialize runtime
  const runtime = new OpenClawRuntime(env, runDir, scenario.runtime.model);
  const instances = await runtime.initialize(scenario.runtime.instance_count);
  console.log(`\nInitialized ${instances.length} instances`);

  // 5. Reset and start
  console.log("Resetting instance state...");
  await runtime.resetInstances();

  console.log("Starting containers...");
  await runtime.start();

  console.log(`Waiting for containers to become healthy (${scenario.runtime.health_timeout_seconds}s timeout)...`);
  await runtime.waitHealthy(scenario.runtime.health_timeout_seconds);
  console.log("All instances healthy.\n");

  // 5. Resolve prompt
  console.log("Resolving prompt...");
  const { prompt, source } = await resolvePrompt(scenario, env, runDir);
  console.log(`Prompt source: ${source}\n`);

  // 6. Execute steps for each instance in parallel
  const instanceResults: InstanceRunResult[] = [];

  try {
    const evidenceMap = await executeSteps(runtime, instances, scenario, prompt, env);

    // 7. Export snapshots and refresh evidence to final state
    for (const inst of instances) {
      await runtime.exportLogs(inst);
      await runtime.exportInstanceSnapshot(inst);
    }

    // 8. Re-read final state for assertions (evidence collected during steps
    //    may be stale if the agent wrote config/credentials asynchronously)
    console.log("\nRefreshing evidence to final state...");
    for (const inst of instances) {
      const evidence = evidenceMap.get(inst.id)!;
      // Re-read openclaw.json
      const configContent = await runtime.readInstanceFile(inst, ".openclaw/openclaw.json");
      if (configContent) {
        try {
          evidence.openclawConfig = JSON.parse(configContent);
        } catch { /* keep existing */ }
      }
      // Re-read credentials
      await readInstanceCredentials(inst, evidence);
    }

    // 9. Run assertions for each instance
    for (const inst of instances) {
      const evidence = evidenceMap.get(inst.id)!;
      const assertions = await runAssertions(scenario, env, inst, evidence);
      const hasFailed = assertions.some(a => a.status === "failed" || a.status === "error");
      instanceResults.push({
        id: inst.id,
        status: hasFailed ? "failed" : "passed",
        assertions,
        artifacts: {
          log: resolve(inst.artifactDir, "container.log"),
          openclawConfig: resolve(inst.artifactDir, "openclaw.json"),
        },
      });
    }
  } catch (err) {
    console.error("Scenario execution error:", err);
    for (const inst of instances) {
      await runtime.exportLogs(inst);
      instanceResults.push({
        id: inst.id,
        status: "error",
        assertions: [],
        artifacts: {},
      });
    }
  } finally {
    // 9. Stop containers
    console.log("\nStopping containers...");
    await runtime.stop();
  }

  // 10. Generate report
  const allPassed = instanceResults.every(r => r.status === "passed");
  const report: RunReport = {
    runId,
    scenario: scenario.id,
    environment: envName,
    startTime,
    endTime: new Date().toISOString(),
    status: allPassed ? "passed" : "failed",
    instances: instanceResults,
  };

  await writeFile(resolve(runDir, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

/**
 * Resolve target instances for a step.
 * - "all" (default): all instances
 * - "instance-1", "instance-2", etc.: specific instance by ID
 * - number (1, 2): specific instance by index
 */
function resolveTargetInstances(
  instances: InstanceState[],
  target?: unknown,
): InstanceState[] {
  if (!target || target === "all") return instances;
  if (typeof target === "number") {
    const inst = instances[target - 1];
    return inst ? [inst] : instances;
  }
  if (typeof target === "string") {
    const found = instances.find(i => i.id === target);
    return found ? [found] : instances;
  }
  return instances;
}

/**
 * Read credentials from an instance's .botcord/credentials/ directory
 * and populate the evidence map.
 *
 * When multiple credential files exist (e.g. after a re-registration),
 * reads the newest one and logs a warning about credential drift.
 */
async function readInstanceCredentials(
  inst: InstanceState,
  evidence: InstanceEvidence,
): Promise<void> {
  const credDir = resolve(inst.instanceDir, ".botcord", "credentials");
  try {
    const files = await readdir(credDir);
    const jsonFiles = files.filter(f => f.endsWith(".json"));
    if (jsonFiles.length === 0) {
      console.warn(`  [${inst.id}] No credentials files found`);
      return;
    }

    if (jsonFiles.length > 1) {
      console.warn(`  [${inst.id}] WARNING: ${jsonFiles.length} credential files found — possible re-registration drift`);
      for (const f of jsonFiles) {
        console.warn(`    - ${f}`);
      }
    }

    // Pick the newest file by mtime to get the most current identity
    const { stat } = await import("node:fs/promises");
    let newest = jsonFiles[0];
    let newestMtime = 0;
    for (const f of jsonFiles) {
      const s = await stat(resolve(credDir, f));
      if (s.mtimeMs > newestMtime) {
        newestMtime = s.mtimeMs;
        newest = f;
      }
    }

    const credPath = resolve(credDir, newest);
    const content = await readFileFs(credPath, "utf-8");
    const parsed = JSON.parse(content);
    evidence.credentials = parsed;
    evidence.credentialsPath = credPath;

    // Also check if openclaw.json points to a different credential file
    // than what we read — this indicates drift
    const config = evidence.openclawConfig;
    const channels = config?.["channels"] as Record<string, Record<string, unknown>> | undefined;
    const configCredFile = channels?.["botcord"]?.["credentialsFile"] as string | undefined;
    if (configCredFile) {
      const { basename } = await import("node:path");
      const configFilename = basename(configCredFile);
      if (configFilename !== newest) {
        console.warn(`  [${inst.id}] DRIFT: openclaw.json points to ${configFilename} but newest credential is ${newest}`);
      }
    }

    console.log(`  [${inst.id}] Found credentials: ${newest}${jsonFiles.length > 1 ? ` (newest of ${jsonFiles.length})` : ""}`);
  } catch {
    console.warn(`  [${inst.id}] Could not read credentials directory`);
  }
}

/**
 * Extract a room ID from agent output.
 * Searches both text payload and raw JSON for rm_ prefixed IDs.
 */
function extractRoomId(result: AgentResult): string | undefined {
  // Search text payload first
  const text = result.text ?? "";
  const textMatch = text.match(/rm_[a-zA-Z0-9_-]+/);
  if (textMatch) return textMatch[0];
  // Fall back to searching raw JSON (tool call results contain room IDs)
  const rawMatch = result.raw.match(/rm_[a-zA-Z0-9_-]+/);
  return rawMatch?.[0];
}

/**
 * Extract an invite code from agent output.
 * Searches both text and raw JSON.
 */
function extractInviteCode(result: AgentResult): string | undefined {
  const sources = [result.text ?? "", result.raw];
  const patterns = [
    /invites\/([a-zA-Z0-9_-]+)\/redeem/,
    /invites\/([a-zA-Z0-9_-]+)/,
    /invite[_\s-]*code[:\s]*["']?([a-zA-Z0-9_-]+)["']?/i,
    /"code"\s*:\s*"([a-zA-Z0-9_-]{6,})"/,
  ];
  for (const text of sources) {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m?.[1]) return m[1];
    }
  }
  return undefined;
}

/**
 * Extract a share ID from agent output.
 * Searches both text and raw JSON.
 */
function extractShareId(result: AgentResult): string | undefined {
  const sources = [result.text ?? "", result.raw];
  const patterns = [
    /share\/([a-zA-Z0-9_-]+)/,
    /share[_\s-]*id[:\s]*["']?([a-zA-Z0-9_-]+)["']?/i,
    /"shareId"\s*:\s*"([a-zA-Z0-9_-]+)"/,
  ];
  for (const text of sources) {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m?.[1]) return m[1];
    }
  }
  return undefined;
}

/**
 * Extract a claim code (clm_xxx) from agent output.
 */
function extractClaimCode(result: AgentResult): string | undefined {
  const sources = [result.text ?? "", result.raw];
  for (const text of sources) {
    const m = text.match(/clm_[a-fA-F0-9]{32}/);
    if (m) return m[0];
  }
  return undefined;
}

/** Fixed E2E test user UUID for auto-claiming agents. */
const E2E_TEST_USER_ID = "e2e00000-0000-0000-0000-000000000001";

/**
 * Delete all test data associated with the E2E test user.
 * Resolves agent_ids by user_id, then cascades through all dependent tables.
 */
export async function cleanupE2EData(env: EnvironmentConfig): Promise<void> {
  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    console.log("  Cleanup skipped: no DB URL configured");
    return;
  }
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      // All dependent tables referencing agents.agent_id
      const dependentTables = [
        ["wallet_entries", "agent_id"],
        ["wallet_accounts", "agent_id"],
        ["topup_requests", "agent_id"],
        ["withdrawal_requests", "agent_id"],
        ["subscription_charge_attempts", "subscription_id", "agent_subscriptions"],
        ["agent_subscriptions", "subscriber_agent_id"],
        ["agent_subscriptions", "provider_agent_id"],
        ["subscription_products", "owner_agent_id"],
        ["subscription_room_creator_policies", "agent_id"],
        ["used_nonces", "agent_id"],
        ["challenges", "agent_id"],
        ["signing_keys", "agent_id"],
        ["invite_redemptions", "redeemer_agent_id"],
        ["invites", "creator_agent_id"],
        ["contacts", "owner_id"],
        ["contacts", "contact_agent_id"],
        ["contact_requests", "from_agent_id"],
        ["contact_requests", "to_agent_id"],
        ["blocks", "owner_id"],
        ["room_join_requests", "agent_id"],
        ["room_members", "agent_id"],
        ["topics", "creator_id"],
        ["shares", "shared_by_agent_id"],
        ["message_records", "sender_id"],
        ["file_records", "uploader_id"],
        ["endpoints", "agent_id"],
      ];

      // Delete rooms owned by E2E agents (room_members FK prevents direct agent delete)
      // Must delete room_members for those rooms first, then the rooms
      await client.query(`
        DELETE FROM room_members WHERE room_id IN (
          SELECT room_id FROM rooms WHERE owner_id IN (
            SELECT agent_id FROM agents WHERE user_id = $1
          )
        )
      `, [E2E_TEST_USER_ID]);
      await client.query(`
        DELETE FROM rooms WHERE owner_id IN (
          SELECT agent_id FROM agents WHERE user_id = $1
        )
      `, [E2E_TEST_USER_ID]);

      // Delete from all dependent tables
      let totalDeleted = 0;
      for (const [table, column] of dependentTables) {
        const res = await client.query(
          `DELETE FROM ${table} WHERE ${column} IN (SELECT agent_id FROM agents WHERE user_id = $1)`,
          [E2E_TEST_USER_ID],
        );
        if (res.rowCount && res.rowCount > 0) totalDeleted += res.rowCount;
      }

      // Finally delete agents themselves
      const agentRes = await client.query(
        `DELETE FROM agents WHERE user_id = $1`,
        [E2E_TEST_USER_ID],
      );
      const agentCount = agentRes.rowCount ?? 0;
      totalDeleted += agentCount;

      if (totalDeleted > 0) {
        console.log(`  Cleaned up ${agentCount} E2E agents and ${totalDeleted - agentCount} related rows`);
      } else {
        console.log("  No E2E data to clean up");
      }
    } finally {
      await client.end();
    }
  } catch (err) {
    console.warn(`  Cleanup failed (non-fatal): ${err}`);
  }
}

/**
 * Auto-claim an agent by directly updating the database.
 * Sets user_id and claimed_at so the agent is considered "claimed"
 * and the LLM won't ask the user to claim before proceeding.
 */
async function autoClaimAgent(
  claimCode: string,
  env: EnvironmentConfig,
  instanceId: string,
): Promise<boolean> {
  const dbUrl = process.env[env.db_url_env];
  if (!dbUrl) {
    console.warn(`  [${instanceId}] Cannot auto-claim: ${env.db_url_env} not set`);
    return false;
  }
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: dbUrl });
    try {
      await client.connect();
      const res = await client.query(
        `UPDATE agents SET user_id = $1, claimed_at = NOW() WHERE claim_code = $2 AND user_id IS NULL`,
        [E2E_TEST_USER_ID, claimCode],
      );
      if (res.rowCount && res.rowCount > 0) {
        console.log(`  [${instanceId}] Auto-claimed agent (claim_code=${claimCode})`);
        return true;
      } else {
        console.warn(`  [${instanceId}] Auto-claim: no matching unclaimed agent for ${claimCode}`);
        return false;
      }
    } finally {
      await client.end();
    }
  } catch (err) {
    console.error(`  [${instanceId}] Auto-claim failed: ${err}`);
    return false;
  }
}

async function executeSteps(
  runtime: OpenClawRuntime,
  instances: InstanceState[],
  scenario: ScenarioConfig,
  prompt: string,
  env: EnvironmentConfig,
): Promise<Map<string, InstanceEvidence>> {
  const evidenceMap = new Map<string, InstanceEvidence>();
  for (const inst of instances) {
    evidenceMap.set(inst.id, { agentResults: {} });
  }

  for (const step of scenario.steps) {
    console.log(`Step: ${step.id} — ${step.description}`);
    const targets = resolveTargetInstances(instances, step.params?.target);

    switch (step.action) {
      // ── Agent prompt (parallel on target instances) ──────────────
      case "openclaw.agent_prompt": {
        let message = step.params?.message as string | undefined ?? prompt;
        // Resolve placeholders
        message = message.replace("{botcord_env_preset}", env.botcord_env_preset);
        // Resolve dynamic placeholders from evidence
        for (const inst of targets) {
          const ev = evidenceMap.get(inst.id)!;
          let resolved = message;
          resolved = resolved.replace("{agentId}", (ev.credentials?.["agentId"] as string) ?? "");
          resolved = resolved.replace("{roomId}", ev.roomId ?? ev.peerRoomId ?? "");
          resolved = resolved.replace("{inviteCode}", ev.inviteCode ?? ev.peerInviteCode ?? "");
          resolved = resolved.replace("{shareId}", ev.shareId ?? ev.peerShareId ?? "");
          resolved = resolved.replace("{friendInviteCode}", ev.friendInviteCode ?? ev.peerFriendInviteCode ?? "");
          resolved = resolved.replace("{peerAgentId}", ev.peerAgentId ?? "");

          console.log(`  [${inst.id}] Sending prompt...`);
          const result = await runtime.execAgent(inst, resolved, step.id);
          console.log(`  [${inst.id}] Exit code: ${result.exitCode}, status: ${result.status ?? "unknown"}`);
          ev.agentResults[step.id] = result;

          // Auto-extract known IDs from output
          if (step.params?.extract_room_id) {
            const roomId = extractRoomId(result);
            if (roomId) {
              ev.roomId = roomId;
              console.log(`  [${inst.id}] Extracted roomId: ${roomId}`);
            }
          }
          if (step.params?.extract_invite_code) {
            const code = extractInviteCode(result);
            if (code) {
              ev.inviteCode = code;
              console.log(`  [${inst.id}] Extracted inviteCode: ${code}`);
            }
          }
          if (step.params?.extract_share_id) {
            const sid = extractShareId(result);
            if (sid) {
              ev.shareId = sid;
              console.log(`  [${inst.id}] Extracted shareId: ${sid}`);
            }
          }

          // Healthcheck step tagging
          if (step.id === "run_healthcheck") {
            ev.healthcheckResult = result;
          }
        }
        break;
      }

      // ── Prompt built dynamically from frontend builder or direct message ──
      case "openclaw.dynamic_prompt": {
        const kind = step.params?.kind as string | undefined;
        const directMessage = step.params?.message as string | undefined;
        if (!kind && !directMessage) {
          console.warn("  Missing 'kind' or 'message' param for dynamic_prompt — skipping");
          break;
        }
        for (const inst of targets) {
          const ev = evidenceMap.get(inst.id)!;
          let message: string;
          if (directMessage) {
            // Direct message with placeholder substitution
            message = directMessage;
            message = message.replace(/\{agentId\}/g, (ev.credentials?.["agentId"] as string) ?? "");
            message = message.replace(/\{roomId\}/g, ev.roomId ?? ev.peerRoomId ?? "");
            message = message.replace(/\{inviteCode\}/g, ev.inviteCode ?? ev.peerInviteCode ?? "");
            message = message.replace(/\{shareId\}/g, ev.shareId ?? ev.peerShareId ?? "");
            message = message.replace(/\{friendInviteCode\}/g, ev.friendInviteCode ?? ev.peerFriendInviteCode ?? "");
            message = message.replace(/\{peerAgentId\}/g, ev.peerAgentId ?? "");
            message = message.replace(/\{hubBaseUrl\}/g, env.hub_base_url);
            console.log(`  [${inst.id}] Direct message (${message.length} chars)`);
          } else {
            // Build params from evidence + step params
            const promptParams: Record<string, unknown> = {
              ...(step.params ?? {}),
              agentId: ev.credentials?.["agentId"],
              roomId: ev.roomId ?? ev.peerRoomId,
              inviteCode: ev.inviteCode ?? ev.peerInviteCode,
              shareId: ev.shareId ?? ev.peerShareId,
              friendInviteCode: ev.friendInviteCode ?? ev.peerFriendInviteCode,
            };
            message = await resolvePromptByKind(kind!, env, promptParams);
            console.log(`  [${inst.id}] Built dynamic prompt (kind=${kind}, ${message.length} chars)`);
          }
          try {
            const result = await runtime.execAgent(inst, message, step.id);
            console.log(`  [${inst.id}] Exit code: ${result.exitCode}, status: ${result.status ?? "unknown"}`);
            ev.agentResults[step.id] = result;

            if (step.params?.extract_room_id) {
              const roomId = extractRoomId(result);
              if (roomId) { ev.roomId = roomId; console.log(`  [${inst.id}] Extracted roomId: ${roomId}`); }
            }
            if (step.params?.extract_invite_code) {
              const code = extractInviteCode(result);
              if (code) { ev.inviteCode = code; console.log(`  [${inst.id}] Extracted inviteCode: ${code}`); }
            }
            if (step.params?.extract_share_id) {
              const sid = extractShareId(result);
              if (sid) { ev.shareId = sid; console.log(`  [${inst.id}] Extracted shareId: ${sid}`); }
            }
          } catch (err) {
            console.error(`  [${inst.id}] Dynamic prompt failed: ${err}`);
            ev.agentResults[step.id] = { raw: "", exitCode: 1 };
          }
        }
        break;
      }

      // ── Wait for healthy ────────────────────────────────────────
      case "runtime.wait_healthy": {
        const delay = (step.params?.delay_seconds as number) ?? scenario.runtime.gateway_recovery_seconds;
        console.log(`  Waiting ${delay}s for gateway recovery...`);
        await sleep(delay * 1000);
        await runtime.waitHealthy(scenario.runtime.health_timeout_seconds);
        console.log("  All instances healthy after recovery.");
        break;
      }

      // ── Auto-claim agents via DB ────────────────────────────────
      case "runtime.auto_claim": {
        for (const inst of targets) {
          const ev = evidenceMap.get(inst.id)!;
          // Find claim code from any previous agent result
          let claimCode: string | undefined;
          for (const result of Object.values(ev.agentResults)) {
            claimCode = extractClaimCode(result);
            if (claimCode) break;
          }
          if (claimCode) {
            await autoClaimAgent(claimCode, env, inst.id);
          } else {
            console.warn(`  [${inst.id}] No claim code found in agent outputs — skipping auto-claim`);
          }
        }
        break;
      }

      // ── Read JSON file ──────────────────────────────────────────
      case "filesystem.read_json": {
        const path = step.params?.path as string;
        if (path) {
          await Promise.all(
            targets.map(async (inst) => {
              const content = await runtime.readInstanceFile(inst, path);
              if (content) {
                try {
                  const parsed = JSON.parse(content);
                  if (step.id === "read_openclaw_config") {
                    evidenceMap.get(inst.id)!.openclawConfig = parsed;
                  }
                  console.log(`  [${inst.id}] Read ${path} OK`);
                } catch {
                  console.warn(`  [${inst.id}] ${path} is not valid JSON`);
                }
              } else {
                console.warn(`  [${inst.id}] ${path} not found`);
              }
            }),
          );
        }
        break;
      }

      // ── Read credentials ────────────────────────────────────────
      case "filesystem.read_credentials": {
        await Promise.all(
          targets.map(async (inst) => {
            await readInstanceCredentials(inst, evidenceMap.get(inst.id)!);
          }),
        );
        break;
      }

      // ── Backup credentials (before reset/destructive ops) ──────
      case "filesystem.backup_credentials": {
        for (const inst of targets) {
          const ev = evidenceMap.get(inst.id)!;
          if (ev.credentials) {
            ev.credentialsBackup = { ...ev.credentials };
            console.log(`  [${inst.id}] Backed up credentials (agentId=${ev.credentials["agentId"]})`);
          } else {
            console.warn(`  [${inst.id}] No credentials to backup`);
          }
        }
        break;
      }

      // ── Delete credentials (simulate credential loss for reset) ─
      case "filesystem.delete_credentials": {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        for (const inst of targets) {
          const credDir = resolve(inst.instanceDir, ".botcord", "credentials");
          try {
            await execFileAsync("rm", ["-rf", credDir]);
            const { mkdir: mk } = await import("node:fs/promises");
            await mk(credDir, { recursive: true });
            evidenceMap.get(inst.id)!.credentials = undefined;
            evidenceMap.get(inst.id)!.credentialsPath = undefined;
            console.log(`  [${inst.id}] Deleted credentials`);
          } catch {
            console.warn(`  [${inst.id}] Could not delete credentials`);
          }
        }
        break;
      }

      // ── DB query (deferred to assertions) ───────────────────────
      case "db.query": {
        console.log("  DB queries will be executed during assertion phase.");
        break;
      }

      // ── Switch environment by rewriting credentials hubUrl ──────
      // This does exactly what /botcord_env does internally:
      // read credentials file → update hubUrl → write back.
      // More reliable than sending /botcord_env as an agent message,
      // since slash commands are intercepted by the gateway, not the LLM.
      case "runtime.switch_env": {
        const targetUrl = env.hub_base_url;
        await Promise.all(
          targets.map(async (inst) => {
            const credDir = resolve(inst.instanceDir, ".botcord", "credentials");
            try {
              const files = await readdir(credDir);
              const jsonFiles = files.filter(f => f.endsWith(".json"));
              if (jsonFiles.length === 0) {
                console.warn(`  [${inst.id}] No credentials file to update — skipping env switch`);
                return;
              }
              for (const f of jsonFiles) {
                const credPath = resolve(credDir, f);
                const raw = await readFileFs(credPath, "utf-8");
                const creds = JSON.parse(raw);
                const oldUrl = creds.hubUrl;
                creds.hubUrl = targetUrl;
                await writeFile(credPath, JSON.stringify(creds, null, 2));
                console.log(`  [${inst.id}] Switched hubUrl: ${oldUrl} → ${targetUrl}`);
              }
            } catch (err) {
              console.warn(`  [${inst.id}] Failed to switch env: ${err}`);
            }
          }),
        );
        break;
      }

      // ── Restart and wait (no healthcheck) ───────────────────────
      case "runtime.restart_and_wait": {
        console.log("  Restarting instances...");
        await Promise.all(
          targets.map(async (inst) => {
            await runtime.restartInstance(inst);
          }),
        );
        console.log("  Waiting for instances to become healthy after restart...");
        await runtime.waitHealthy(scenario.runtime.health_timeout_seconds);
        console.log("  All instances healthy after restart.");
        break;
      }

      // ── Restart and verify with healthcheck ─────────────────────
      case "runtime.restart_and_verify": {
        console.log("  Restarting instances...");
        await Promise.all(
          targets.map(async (inst) => {
            await runtime.restartInstance(inst);
          }),
        );
        console.log("  Waiting for instances to become healthy after restart...");
        await runtime.waitHealthy(scenario.runtime.health_timeout_seconds);
        console.log("  All instances healthy after restart.");

        await Promise.all(
          targets.map(async (inst) => {
            console.log(`  [${inst.id}] Running post-restart healthcheck...`);
            const result = await runtime.execAgent(inst, "/botcord_healthcheck", "post-restart-healthcheck");
            evidenceMap.get(inst.id)!.restartHealthcheckResult = result;
            console.log(`  [${inst.id}] Post-restart healthcheck: exit=${result.exitCode}`);
          }),
        );
        break;
      }

      // ── Cross-instance evidence sharing ─────────────────────────
      // Copies evidence from one instance to another (peer references)
      case "evidence.share_cross_instance": {
        const fromIdx = (step.params?.from_instance as number) ?? 1;
        const toIdx = (step.params?.to_instance as number) ?? 2;
        const fromInst = instances[fromIdx - 1];
        const toInst = instances[toIdx - 1];
        if (fromInst && toInst) {
          const fromEv = evidenceMap.get(fromInst.id)!;
          const toEv = evidenceMap.get(toInst.id)!;
          toEv.peerAgentId = fromEv.credentials?.["agentId"] as string | undefined;
          toEv.peerRoomId = fromEv.roomId;
          toEv.peerInviteCode = fromEv.inviteCode;
          toEv.peerShareId = fromEv.shareId;
          toEv.peerFriendInviteCode = fromEv.friendInviteCode;
          console.log(`  Shared evidence from ${fromInst.id} -> ${toInst.id}`);
          // Also share reverse direction if bidirectional
          if (step.params?.bidirectional) {
            fromEv.peerAgentId = toEv.credentials?.["agentId"] as string | undefined;
            fromEv.peerRoomId = toEv.roomId;
            fromEv.peerInviteCode = toEv.inviteCode;
            fromEv.peerShareId = toEv.shareId;
            fromEv.peerFriendInviteCode = toEv.friendInviteCode;
            console.log(`  Shared evidence from ${toInst.id} -> ${fromInst.id} (bidirectional)`);
          }
        }
        break;
      }

      // ── Verify container logs (check for error patterns) ────────
      case "runtime.check_logs": {
        const errorPatterns = (step.params?.error_patterns as string[]) ?? [];
        for (const inst of targets) {
          const logPath = await runtime.exportLogs(inst);
          if (logPath) {
            const logContent = await readFileFs(logPath, "utf-8");
            const ev = evidenceMap.get(inst.id)!;
            ev.agentResults[step.id] = {
              raw: logContent,
              exitCode: 0,
            };
            for (const pattern of errorPatterns) {
              if (logContent.includes(pattern)) {
                console.warn(`  [${inst.id}] Found error pattern in logs: "${pattern}"`);
              }
            }
            console.log(`  [${inst.id}] Logs exported (${logContent.length} chars)`);
          }
        }
        break;
      }

      default:
        console.warn(`  Unknown action: ${step.action} — skipping`);
    }
  }

  return evidenceMap;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
