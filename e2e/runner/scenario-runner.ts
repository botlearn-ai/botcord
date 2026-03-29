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

  // 3. Initialize runtime
  const runtime = new OpenClawRuntime(env, runDir, scenario.runtime.model);
  const instances = await runtime.initialize(scenario.runtime.instance_count);
  console.log(`\nInitialized ${instances.length} instances`);

  // 4. Reset and start
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
      const allPassed = assertions.every(a => a.status === "passed");
      instanceResults.push({
        id: inst.id,
        status: allPassed ? "passed" : "failed",
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
 */
async function readInstanceCredentials(
  inst: InstanceState,
  evidence: InstanceEvidence,
): Promise<void> {
  const credDir = resolve(inst.instanceDir, ".botcord", "credentials");
  try {
    const files = await readdir(credDir);
    const jsonFiles = files.filter(f => f.endsWith(".json"));
    if (jsonFiles.length > 0) {
      const credPath = resolve(credDir, jsonFiles[0]);
      const content = await readFileFs(credPath, "utf-8");
      const parsed = JSON.parse(content);
      evidence.credentials = parsed;
      evidence.credentialsPath = credPath;
      console.log(`  [${inst.id}] Found credentials: ${jsonFiles[0]}`);
    } else {
      console.warn(`  [${inst.id}] No credentials files found`);
    }
  } catch {
    console.warn(`  [${inst.id}] Could not read credentials directory`);
  }
}

/**
 * Extract a room ID from agent output text.
 * Looks for patterns like rm_xxx in the response.
 */
function extractRoomId(result: AgentResult): string | undefined {
  const text = result.text ?? result.raw;
  const match = text.match(/rm_[a-zA-Z0-9_-]+/);
  return match?.[0];
}

/**
 * Extract an invite code from agent output text.
 */
function extractInviteCode(result: AgentResult): string | undefined {
  const text = result.text ?? result.raw;
  // Look for invite code in various formats
  const patterns = [
    /invite[_\s-]*code[:\s]*["']?([a-zA-Z0-9_-]+)["']?/i,
    /code[:\s]*["']?([a-zA-Z0-9_-]{6,})["']?/i,
    /invites\/([a-zA-Z0-9_-]+)/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * Extract a share ID from agent output text.
 */
function extractShareId(result: AgentResult): string | undefined {
  const text = result.text ?? result.raw;
  const match = text.match(/share[_\s-]*id[:\s]*["']?([a-zA-Z0-9_-]+)["']?/i)
    ?? text.match(/rooms\/share\/([a-zA-Z0-9_-]+)/);
  return match?.[1];
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

      // ── Prompt built dynamically from frontend builder ──────────
      case "openclaw.dynamic_prompt": {
        const kind = step.params?.kind as string;
        if (!kind) {
          console.warn("  Missing 'kind' param for dynamic_prompt — skipping");
          break;
        }
        for (const inst of targets) {
          const ev = evidenceMap.get(inst.id)!;
          // Build params from evidence + step params
          const promptParams: Record<string, unknown> = {
            ...(step.params ?? {}),
            agentId: ev.credentials?.["agentId"],
            roomId: ev.roomId ?? ev.peerRoomId,
            inviteCode: ev.inviteCode ?? ev.peerInviteCode,
            shareId: ev.shareId ?? ev.peerShareId,
            friendInviteCode: ev.friendInviteCode ?? ev.peerFriendInviteCode,
          };
          try {
            const message = await resolvePromptByKind(kind, env, promptParams);
            console.log(`  [${inst.id}] Built dynamic prompt (kind=${kind}, ${message.length} chars)`);
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
