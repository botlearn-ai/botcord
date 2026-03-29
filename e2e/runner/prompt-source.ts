import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EnvironmentConfig, ScenarioConfig } from "./types.js";

/**
 * Path to the real frontend prompt builder — the single source of truth.
 * We import and call it directly so that any prompt regression in the
 * frontend is caught by E2E.
 */
const FRONTEND_ONBOARDING_PATH = resolve(
  import.meta.dirname,
  "../../frontend/src/lib/onboarding.ts",
);

/**
 * Get the setup guide URL for an environment.
 */
export function getSetupGuideUrl(env: EnvironmentConfig): string {
  const variant = env.quickstart_variant === "beta" ? "-beta" : "";
  return `${env.docs_base_url}/openclaw-setup-instruction-script${variant}.md`;
}

/**
 * Build a fallback prompt from the scenario override template.
 */
function buildOverridePrompt(scenario: ScenarioConfig, env: EnvironmentConfig): string {
  const template = scenario.prompt.override_template;
  if (!template) {
    throw new Error("No override template defined in scenario config");
  }
  const guideUrl = getSetupGuideUrl(env);
  return template.replace("{setup_guide_url}", guideUrl);
}

/**
 * Call a named frontend prompt builder with the given options.
 * Supports all prompt types defined in frontend/src/lib/onboarding.ts.
 */
async function callFrontendPromptBuilderByKind(
  kind: string,
  env: EnvironmentConfig,
  params?: Record<string, unknown>,
): Promise<string> {
  const prevAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = env.web_base_url;

  try {
    const mod = await import(FRONTEND_ONBOARDING_PATH);
    const installGuideUrl = getSetupGuideUrl(env);

    switch (kind) {
      case "homepage_quickstart":
      case "connect_bot": {
        const fn = mod.buildConnectBotPrompt as Function;
        return fn({
          installGuideUrl,
          locale: "en",
          mode: params?.["mode"] as string | undefined,
          connectionCode: params?.["connectionCode"] as string | undefined,
          connectionInstruction: params?.["connectionInstruction"] as string | undefined,
          hubApiBaseUrl: env.hub_base_url,
        });
      }
      case "create_room": {
        const fn = mod.buildCreateRoomPrompt as Function;
        return fn({ locale: "en" });
      }
      case "self_join": {
        const fn = mod.buildSelfJoinPrompt as Function;
        return fn({
          roomId: params?.["roomId"] as string,
          roomName: params?.["roomName"] as string ?? "Test Room",
          hubApiBaseUrl: env.hub_base_url,
          installGuideUrl,
          locale: "en",
        });
      }
      case "share_invite": {
        const fn = mod.buildSharePrompt as Function;
        return fn({
          shareId: params?.["shareId"] as string | undefined,
          inviteCode: params?.["inviteCode"] as string | undefined,
          roomId: params?.["roomId"] as string | undefined,
          roomName: params?.["roomName"] as string | undefined,
          requiresPayment: params?.["requiresPayment"] as boolean | undefined,
          isReadOnly: params?.["isReadOnly"] as boolean | undefined,
          hubApiBaseUrl: env.hub_base_url,
          installGuideUrl,
          locale: "en",
        });
      }
      case "friend_invite": {
        const fn = mod.buildFriendInvitePrompt as Function;
        return fn({
          inviteCode: params?.["inviteCode"] as string,
          hubApiBaseUrl: env.hub_base_url,
          installGuideUrl,
          locale: "en",
        });
      }
      case "reset_credential": {
        const fn = mod.buildResetCredentialPrompt as Function;
        return fn({
          agentId: params?.["agentId"] as string,
          resetCode: params?.["resetCode"] as string,
          hubUrl: env.hub_base_url,
          locale: "en",
        });
      }
      default:
        throw new Error(`Unknown prompt kind: ${kind}`);
    }
  } finally {
    if (prevAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = prevAppUrl;
    }
  }
}

/**
 * Resolve the prompt to send to OpenClaw.
 *
 * For "frontend-derived": imports and calls the real prompt builder
 * from frontend/src/lib/onboarding.ts — the same functions the UI uses.
 * This guarantees that prompt regressions in the frontend break E2E.
 *
 * For "scenario-override": uses the template from scenario config.
 *
 * Saves the resolved prompt and its source to artifacts.
 */
export async function resolvePrompt(
  scenario: ScenarioConfig,
  env: EnvironmentConfig,
  artifactDir: string,
  params?: Record<string, unknown>,
): Promise<{ prompt: string; source: string; url?: string }> {
  let prompt: string;
  let source: string;
  let url: string | undefined;

  if (scenario.prompt.source === "frontend-derived") {
    url = getSetupGuideUrl(env);
    try {
      prompt = await callFrontendPromptBuilderByKind(scenario.prompt.kind, env, params);
      source = "frontend-derived";
      console.log(`  Called frontend prompt builder (kind=${scenario.prompt.kind}, ${prompt.length} chars)`);
    } catch (err) {
      console.warn(`  Failed to import frontend prompt builder: ${err}`);
      if (scenario.prompt.fallback === "scenario-override") {
        console.log("  Falling back to scenario override template");
        prompt = buildOverridePrompt(scenario, env);
        source = "scenario-override-fallback";
      } else {
        throw err;
      }
    }
  } else {
    prompt = buildOverridePrompt(scenario, env);
    source = "scenario-override";
  }

  // Save prompt and metadata to artifacts
  await writeFile(resolve(artifactDir, "prompt.md"), prompt);
  await writeFile(
    resolve(artifactDir, "prompt-metadata.json"),
    JSON.stringify({ source, kind: scenario.prompt.kind, url, length: prompt.length, timestamp: new Date().toISOString() }, null, 2),
  );

  return { prompt, source, url };
}

/**
 * Resolve a prompt by kind with dynamic parameters.
 * Used by scenario steps that need to build prompts mid-execution
 * (e.g. after discovering a roomId or inviteCode from a previous step).
 */
export async function resolvePromptByKind(
  kind: string,
  env: EnvironmentConfig,
  params: Record<string, unknown>,
): Promise<string> {
  try {
    return await callFrontendPromptBuilderByKind(kind, env, params);
  } catch (err) {
    throw new Error(`Failed to build prompt (kind=${kind}): ${err}`);
  }
}
