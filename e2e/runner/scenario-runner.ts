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
} from "./types.js";
import { getEnvironment } from "./environment.js";
import { OpenClawRuntime } from "./openclaw-runtime.js";
import { resolvePrompt } from "./prompt-source.js";
import { runAssertions } from "./assertions/index.js";

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

    // 7. Export snapshots
    for (const inst of instances) {
      await runtime.exportLogs(inst);
      await runtime.exportInstanceSnapshot(inst);
    }

    // 8. Run assertions for each instance
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

    switch (step.action) {
      case "openclaw.agent_prompt": {
        // Run agent prompt on all instances in parallel
        let message = step.params?.message as string | undefined ?? prompt;
        // Resolve environment placeholders in the message
        message = message.replace("{botcord_env_preset}", env.botcord_env_preset);
        const results = await Promise.all(
          instances.map(async (inst) => {
            console.log(`  [${inst.id}] Sending prompt...`);
            const result = await runtime.execAgent(inst, message);
            console.log(`  [${inst.id}] Exit code: ${result.exitCode}, status: ${result.status ?? "unknown"}`);
            evidenceMap.get(inst.id)!.agentResults[step.id] = result;
            if (step.id === "run_healthcheck") {
              evidenceMap.get(inst.id)!.healthcheckResult = result;
            }
            return result;
          }),
        );
        break;
      }

      case "runtime.wait_healthy": {
        const delay = (step.params?.delay_seconds as number) ?? scenario.runtime.gateway_recovery_seconds;
        console.log(`  Waiting ${delay}s for gateway recovery...`);
        await sleep(delay * 1000);
        await runtime.waitHealthy(scenario.runtime.health_timeout_seconds);
        console.log("  All instances healthy after recovery.");
        break;
      }

      case "filesystem.read_json": {
        const path = step.params?.path as string;
        if (path) {
          await Promise.all(
            instances.map(async (inst) => {
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

      case "filesystem.read_credentials": {
        await Promise.all(
          instances.map(async (inst) => {
            // Look for credentials files in .botcord/credentials/
            const credDir = resolve(inst.instanceDir, ".botcord", "credentials");
            try {
              const { readdir, readFile: rf } = await import("node:fs/promises");
              const files = await readdir(credDir);
              const jsonFiles = files.filter(f => f.endsWith(".json"));
              if (jsonFiles.length > 0) {
                const credPath = resolve(credDir, jsonFiles[0]);
                const content = await rf(credPath, "utf-8");
                const parsed = JSON.parse(content);
                evidenceMap.get(inst.id)!.credentials = parsed;
                evidenceMap.get(inst.id)!.credentialsPath = credPath;
                console.log(`  [${inst.id}] Found credentials: ${jsonFiles[0]}`);
              } else {
                console.warn(`  [${inst.id}] No credentials files found`);
              }
            } catch {
              console.warn(`  [${inst.id}] Could not read credentials directory`);
            }
          }),
        );
        break;
      }

      case "db.query": {
        // DB assertions are run later in the assertion phase
        // Here we just note that this step should be handled by the DB assertion module
        console.log("  DB queries will be executed during assertion phase.");
        break;
      }

      case "runtime.restart_and_wait": {
        // Restart containers and wait for healthy, but no healthcheck prompt
        console.log("  Restarting instances...");
        await Promise.all(
          instances.map(async (inst) => {
            await runtime.restartInstance(inst);
          }),
        );
        console.log("  Waiting for instances to become healthy after restart...");
        await runtime.waitHealthy(scenario.runtime.health_timeout_seconds);
        console.log("  All instances healthy after restart.");
        break;
      }

      case "runtime.restart_and_verify": {
        console.log("  Restarting instances...");
        await Promise.all(
          instances.map(async (inst) => {
            await runtime.restartInstance(inst);
          }),
        );
        console.log("  Waiting for instances to become healthy after restart...");
        await runtime.waitHealthy(scenario.runtime.health_timeout_seconds);
        console.log("  All instances healthy after restart.");

        // Run healthcheck again after restart
        await Promise.all(
          instances.map(async (inst) => {
            console.log(`  [${inst.id}] Running post-restart healthcheck...`);
            const result = await runtime.execAgent(inst, "/botcord_healthcheck");
            evidenceMap.get(inst.id)!.restartHealthcheckResult = result;
            console.log(`  [${inst.id}] Post-restart healthcheck: exit=${result.exitCode}`);
          }),
        );
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
