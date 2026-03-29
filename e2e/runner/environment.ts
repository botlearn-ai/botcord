import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EnvironmentConfig } from "./types.js";

const CONFIG_DIR = resolve(import.meta.dirname, "../config");

interface EnvironmentsFile {
  environments: Record<string, EnvironmentConfig>;
}

let cached: EnvironmentsFile | null = null;

async function loadEnvironments(): Promise<EnvironmentsFile> {
  if (cached) return cached;
  const content = await readFile(resolve(CONFIG_DIR, "environments.yaml"), "utf-8");
  cached = parseYaml(content) as EnvironmentsFile;
  return cached;
}

export async function getEnvironment(envName: string): Promise<EnvironmentConfig> {
  const envs = await loadEnvironments();
  const env = envs.environments[envName];
  if (!env) {
    const available = Object.keys(envs.environments).join(", ");
    throw new Error(`Unknown environment "${envName}". Available: ${available}`);
  }
  return env;
}

export function getDbUrl(env: EnvironmentConfig): string {
  const url = process.env[env.db_url_env];
  if (!url) {
    throw new Error(`Database URL environment variable ${env.db_url_env} is not set`);
  }
  return url;
}

export function getSetupGuideUrl(env: EnvironmentConfig): string {
  const variant = env.quickstart_variant === "beta" ? "-beta" : "";
  return `${env.docs_base_url}/openclaw-setup-instruction-script${variant}.md`;
}

export async function listEnvironments(): Promise<string[]> {
  const envs = await loadEnvironments();
  return Object.keys(envs.environments);
}
