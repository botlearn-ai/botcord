import { cpSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

function resolveOpenClawWorkspace() {
  const customHome = process.env.OPENCLAW_HOME?.trim();
  if (customHome) {
    return path.resolve(customHome, "workspace");
  }
  return path.join(os.homedir(), ".openclaw", "workspace");
}

function installSkill() {
  const sourceSkillDir = path.join(packageRoot, "skills", "botcord");
  const targetSkillDir = path.join(resolveOpenClawWorkspace(), "skills", "botcord");

  if (!existsSync(sourceSkillDir)) {
    console.warn(`[botcord] skill source not found, skipping install: ${sourceSkillDir}`);
    return;
  }

  mkdirSync(path.dirname(targetSkillDir), { recursive: true });
  cpSync(sourceSkillDir, targetSkillDir, { recursive: true, force: true });
  console.log(`[botcord] installed OpenClaw skill to ${targetSkillDir}`);
}

try {
  installSkill();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[botcord] failed to install OpenClaw skill: ${message}`);
}
