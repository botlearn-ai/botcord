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
 * Dynamically import the real buildConnectBotPrompt from the frontend source.
 * This ensures the E2E platform always tests the actual product prompt,
 * not a local copy that can drift.
 */
async function callFrontendPromptBuilder(env: EnvironmentConfig): Promise<string> {
  // Set NEXT_PUBLIC_APP_URL so getBotcordWebAppUrl() inside onboarding.ts
  // resolves to the correct environment URL.
  const prevAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = env.web_base_url;

  try {
    // tsx handles TypeScript imports natively
    const mod = await import(FRONTEND_ONBOARDING_PATH);
    const buildConnectBotPrompt = mod.buildConnectBotPrompt as (options: {
      connectionCode?: string;
      connectionInstruction?: string;
      mode?: string;
      hubApiBaseUrl?: string;
      installGuideUrl?: string;
      locale?: string;
    }) => string;

    if (typeof buildConnectBotPrompt !== "function") {
      throw new Error(
        `buildConnectBotPrompt not found or not a function in ${FRONTEND_ONBOARDING_PATH}`,
      );
    }

    // Call with the same parameters the homepage HeroSection uses,
    // but explicitly pass installGuideUrl for the target environment.
    //
    // Without this, buildConnectBotPrompt falls back to
    // getBotcordInstallGuideUrl() which always returns the stable URL
    // (/openclaw-setup-instruction-script.md), even when the env is beta.
    const installGuideUrl = getSetupGuideUrl(env);
    const prompt = buildConnectBotPrompt({
      installGuideUrl,
      locale: "en",
    });

    return prompt;
  } finally {
    // Restore previous env
    if (prevAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = prevAppUrl;
    }
  }
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
 * Resolve the prompt to send to OpenClaw.
 *
 * For "frontend-derived": imports and calls the real buildConnectBotPrompt()
 * from frontend/src/lib/onboarding.ts — the same function the homepage uses.
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
): Promise<{ prompt: string; source: string; url?: string }> {
  let prompt: string;
  let source: string;
  let url: string | undefined;

  if (scenario.prompt.source === "frontend-derived") {
    url = getSetupGuideUrl(env);
    try {
      prompt = await callFrontendPromptBuilder(env);
      source = "frontend-derived";
      console.log(`  Called real buildConnectBotPrompt() from frontend (${prompt.length} chars)`);
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
    JSON.stringify({ source, url, length: prompt.length, timestamp: new Date().toISOString() }, null, 2),
  );

  return { prompt, source, url };
}
