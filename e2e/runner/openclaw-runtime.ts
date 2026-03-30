import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, cp, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { InstanceState, AgentResult, EnvironmentConfig } from "./types.js";

const execFileAsync = promisify(execFile);

const E2E_DIR = resolve(import.meta.dirname, "..");
const INSTANCES_DIR = resolve(E2E_DIR, "instances");
const COMPOSE_FILE = resolve(E2E_DIR, "docker-compose.yml");

export class OpenClawRuntime {
  private instances: InstanceState[] = [];
  private env: EnvironmentConfig;
  private artifactBaseDir: string;
  private model: string;

  constructor(env: EnvironmentConfig, artifactBaseDir: string, model: string) {
    this.env = env;
    this.artifactBaseDir = artifactBaseDir;
    this.model = model;
  }

  async initialize(instanceCount: number): Promise<InstanceState[]> {
    this.instances = [];
    for (let i = 1; i <= instanceCount; i++) {
      const token = randomBytes(32).toString("hex");
      const sessionId = `e2e-session-${Date.now()}-${i}`;
      const instanceDir = resolve(INSTANCES_DIR, `openclaw-${i}`);
      const artifactDir = resolve(this.artifactBaseDir, `instance-${i}`);
      await mkdir(artifactDir, { recursive: true });

      this.instances.push({
        id: `openclaw-${i}`,
        containerName: `e2e-openclaw-${i}`,
        gatewayToken: token,
        sessionId,
        port: 17000 + (i - 1) * 2 + 1,
        healthPort: 17000 + (i - 1) * 2 + 2,
        artifactDir,
        instanceDir,
      });
    }
    return this.instances;
  }

  async resetInstances(): Promise<void> {
    for (const inst of this.instances) {
      const openclawDir = resolve(inst.instanceDir, ".openclaw");
      const botcordDir = resolve(inst.instanceDir, ".botcord");

      // Nuke entire instance directory to prevent state accumulation
      // (clobbered configs, old logs, device state, etc.)
      try {
        await execFileAsync("rm", ["-rf", inst.instanceDir]);
      } catch {
        // may not exist
      }

      await mkdir(resolve(botcordDir, "credentials"), { recursive: true });
      await mkdir(resolve(openclawDir, "workspace"), { recursive: true });

      // Write fresh openclaw.json matching the proven deploy-npm.sh structure
      // from ~/openclaw_deploy/ — not a reduced variant that may behave differently.
      const openclawJson = {
        agents: {
          defaults: {
            model: {
              primary: this.model,
              fallbacks: [],
            },
            compaction: {
              mode: "safeguard",
            },
          },
        },
        commands: {
          native: "auto",
          nativeSkills: "auto",
          restart: true,
          ownerDisplay: "raw",
        },
        session: {
          dmScope: "per-channel-peer",
        },
        channels: {},
        gateway: {
          mode: "local",
          controlUi: {
            dangerouslyAllowHostHeaderOriginFallback: true,
            allowInsecureAuth: true,
            dangerouslyDisableDeviceAuth: true,
          },
        },
        plugins: {
          entries: {},
          installs: {},
        },
      };
      await mkdir(openclawDir, { recursive: true });
      await writeFile(
        resolve(openclawDir, "openclaw.json"),
        JSON.stringify(openclawJson, null, 2)
      );
    }
  }

  async start(): Promise<void> {
    // Build environment variables for docker compose
    const composeEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };
    for (const inst of this.instances) {
      // Set token for each instance (used in docker-compose.yml as TOKEN_1, TOKEN_2, etc.)
      const idx = inst.id.replace("openclaw-", "");
      composeEnv[`TOKEN_${idx}`] = inst.gatewayToken;
    }

    // Ensure no stale containers from a previous run
    await this.stop();

    await execFileAsync("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"], {
      cwd: E2E_DIR,
      env: composeEnv,
    });
  }

  async stop(): Promise<void> {
    try {
      await execFileAsync("docker", ["compose", "-f", COMPOSE_FILE, "down"], {
        cwd: E2E_DIR,
      });
    } catch {
      // best effort
    }
  }

  async waitHealthy(timeoutSeconds: number = 90): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const pending = new Set(this.instances.map((i) => i.containerName));

    while (pending.size > 0 && Date.now() < deadline) {
      for (const name of [...pending]) {
        try {
          const { stdout } = await execFileAsync("docker", [
            "inspect",
            "--format",
            "{{.State.Health.Status}}",
            name,
          ]);
          if (stdout.trim() === "healthy") {
            pending.delete(name);
          }
        } catch {
          // container may not be ready yet
        }
      }
      if (pending.size > 0) {
        await sleep(2000);
      }
    }

    if (pending.size > 0) {
      throw new Error(
        `Instances failed to become healthy within ${timeoutSeconds}s: ${[...pending].join(", ")}`
      );
    }
  }

  async execAgent(instance: InstanceState, message: string, stepId?: string): Promise<AgentResult> {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      const result = await execFileAsync(
        "docker",
        [
          "exec",
          instance.containerName,
          "openclaw",
          "agent",
          "--session-id",
          instance.sessionId,
          "-m",
          message,
          "--json",
        ],
        { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      // openclaw agent --json returns non-zero exit codes in gateway mode
      // even on success (e.g. 255). The real status is in the JSON output.
      const error = err as { stdout?: string; stderr?: string; code?: number };
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? "";
      exitCode = error.code ?? 1;
    }

    // Parse JSON from stdout regardless of exit code
    let json: Record<string, unknown> | undefined;
    let status: string | undefined;
    let text: string | undefined;

    if (stdout.trim()) {
      try {
        const lines = stdout.trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            json = JSON.parse(lines[i]);
            break;
          } catch {
            continue;
          }
        }
        if (json) {
          status = json["status"] as string | undefined;
          // Extract text from result.payloads[0].text (openclaw --json format)
          const result = json["result"] as Record<string, unknown> | undefined;
          if (result) {
            const payloads = result["payloads"] as Array<Record<string, unknown>> | undefined;
            if (payloads && payloads.length > 0) {
              text = payloads[0]["text"] as string | undefined;
            }
            if (!text) {
              text = (result["text"] as string) ?? (result["message"] as string);
            }
          }
          if (!text && json["text"]) {
            text = json["text"] as string;
          }
        }
      } catch {
        // JSON parse failed, use raw output
      }
    }

    // Save raw output as artifact
    if (stdout) {
      await writeFile(
        resolve(instance.artifactDir, `agent-output-${stepId ?? "default"}-${instance.sessionId}.json`),
        stdout,
      );
    }
    if (stderr) {
      await writeFile(
        resolve(instance.artifactDir, `agent-stderr-${stepId ?? "default"}-${instance.sessionId}.txt`),
        stderr,
      );
    }

    return { raw: stdout, json, status, text, exitCode };
  }

  async restartInstance(instance: InstanceState): Promise<void> {
    await execFileAsync("docker", ["restart", instance.containerName]);
  }

  async exportLogs(instance: InstanceState): Promise<string> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "logs",
        instance.containerName,
      ]);
      const logPath = resolve(instance.artifactDir, "container.log");
      await writeFile(logPath, stdout);
      return logPath;
    } catch {
      return "";
    }
  }

  async exportInstanceSnapshot(instance: InstanceState): Promise<void> {
    // Copy openclaw.json
    const openclawJsonSrc = resolve(
      instance.instanceDir,
      ".openclaw",
      "openclaw.json"
    );
    try {
      await cp(openclawJsonSrc, resolve(instance.artifactDir, "openclaw.json"));
    } catch {
      /* may not exist */
    }

    // Copy credentials
    const credDir = resolve(instance.instanceDir, ".botcord", "credentials");
    try {
      const files = await readdir(credDir);
      for (const f of files) {
        if (f.endsWith(".json")) {
          await cp(
            resolve(credDir, f),
            resolve(instance.artifactDir, `credentials-${f}`)
          );
        }
      }
    } catch {
      /* may not exist */
    }
  }

  async readInstanceFile(
    instance: InstanceState,
    relativePath: string
  ): Promise<string | null> {
    const fullPath = resolve(instance.instanceDir, relativePath);
    try {
      return await readFile(fullPath, "utf-8");
    } catch {
      return null;
    }
  }

  getInstances(): InstanceState[] {
    return this.instances;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
