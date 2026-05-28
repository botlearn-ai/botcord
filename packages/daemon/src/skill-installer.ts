import { execFile, type ExecFileOptions } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  agentCodexHomeDir,
  agentWorkspaceDir,
} from "./agent-workspace.js";
import {
  collectAgentSkillSnapshot,
  type AgentSkillSnapshot,
} from "./skill-index.js";

const execFileAsync = promisify(execFile);

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_INLINE_FILE_BYTES = 256 * 1024;
const TRUSTED_VERCEL_PACKAGE_SPECS = new Set([
  "https://github.com/vercel-labs/skills",
  "github:vercel-labs/skills",
  "vercel-labs/skills",
]);

export type SkillInstallTarget = "claude-code" | "codex";

export interface SkillFileManifest {
  path: string;
  content?: string;
  sourcePath?: string;
}

export interface SkillManifestInput {
  name?: string;
  id?: string;
  description?: string;
  skillMd?: string;
  markdown?: string;
  files?: SkillFileManifest[];
  targetRuntimes?: SkillInstallTarget[];
}

export interface SkillArchiveManifestInput {
  name?: string;
  id?: string;
  description?: string;
  skillMd?: string;
  markdown?: string;
  files?: SkillFileManifest[];
  skills?: SkillManifestInput[];
  targetRuntimes?: SkillInstallTarget[];
}

export interface NormalizedSkillManifest {
  name: string;
  description?: string;
  skillMd: string;
  files: SkillFileManifest[];
  targetRuntimes?: SkillInstallTarget[];
}

export interface InstalledSkillRecord {
  name: string;
  targets: SkillInstallTarget[];
  paths: string[];
}

export interface AgentSkillInstallResult {
  agentId: string;
  installed: InstalledSkillRecord[];
  snapshot: AgentSkillSnapshot;
}

export interface InstallAgentSkillManifestOptions {
  runtime?: string;
  sourceRoot?: string;
}

export interface VercelSkillsInstallOptions {
  agentId: string;
  packageSpec: string;
  skills?: string[];
  runtime?: string;
  executor?: VercelSkillsExecutor;
}

export type VercelSkillsExecutor = (
  command: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<void>;

export function normalizeSkillManifest(input: SkillManifestInput): NormalizedSkillManifest {
  const rawName = input.name ?? input.id;
  if (!rawName) throw new Error("skill manifest requires name or id");
  const name = assertSafeSkillName(rawName);
  const description = sanitizeInline(input.description ?? "");
  const skillMd = input.skillMd ?? input.markdown ?? renderSkillMarkdown(name, description);
  if (!skillMd.trim()) throw new Error(`skill ${name} has empty SKILL.md content`);
  return {
    name,
    ...(description ? { description } : {}),
    skillMd,
    files: input.files ?? [],
    ...(input.targetRuntimes ? { targetRuntimes: normalizeTargets(input.targetRuntimes) } : {}),
  };
}

export function installAgentSkillManifest(
  agentId: string,
  manifest: SkillManifestInput,
  opts: InstallAgentSkillManifestOptions = {},
): AgentSkillInstallResult {
  const normalized = normalizeSkillManifest(manifest);
  const installed = [
    installNormalizedSkill(agentId, normalized, opts),
  ];
  return {
    agentId,
    installed,
    snapshot: collectAgentSkillSnapshot(agentId, { runtime: opts.runtime }),
  };
}

export function installBotLearnArchiveManifest(
  agentId: string,
  archive: SkillArchiveManifestInput,
  opts: InstallAgentSkillManifestOptions = {},
): AgentSkillInstallResult {
  const skills = archive.skills && archive.skills.length > 0
    ? archive.skills
    : [archive];
  const installed = skills.map((skill) => installNormalizedSkill(
    agentId,
    normalizeSkillManifest({
      ...skill,
      targetRuntimes: skill.targetRuntimes ?? archive.targetRuntimes,
    }),
    opts,
  ));
  return {
    agentId,
    installed,
    snapshot: collectAgentSkillSnapshot(agentId, { runtime: opts.runtime }),
  };
}

export async function installVercelSkillsForAgent(
  opts: VercelSkillsInstallOptions,
): Promise<AgentSkillInstallResult> {
  const packageSpec = normalizeTrustedVercelPackageSpec(opts.packageSpec);
  const workspace = agentWorkspaceDir(opts.agentId);
  const tempHome = mkdtempSync(path.join(tmpdir(), "botcord-skills-"));
  const targets = targetsForRuntime(opts.runtime);
  const executor = opts.executor ?? defaultVercelSkillsExecutor;
  const args = buildVercelSkillsArgs(packageSpec, opts.skills, targets);
  try {
    await executor("npx", args, {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
    });
    const installed = importVercelInstalledSkills(opts.agentId, tempHome, targets);
    return {
      agentId: opts.agentId,
      installed,
      snapshot: collectAgentSkillSnapshot(opts.agentId, { runtime: opts.runtime }),
    };
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

export function buildVercelSkillsArgs(
  packageSpec: string,
  skills: string[] | undefined,
  targets: SkillInstallTarget[],
): string[] {
  const normalizedPackageSpec = normalizeTrustedVercelPackageSpec(packageSpec);
  const args = ["--yes", "skills", "add", normalizedPackageSpec, "--global", "--copy", "--yes"];
  for (const skill of skills ?? []) {
    if (!skill.trim()) continue;
    args.push("--skill", skill);
  }
  for (const target of targets) {
    args.push("--agent", target === "codex" ? "codex" : "claude-code");
  }
  return args;
}

function installNormalizedSkill(
  agentId: string,
  manifest: NormalizedSkillManifest,
  opts: InstallAgentSkillManifestOptions,
): InstalledSkillRecord {
  const targets = manifest.targetRuntimes ?? targetsForRuntime(opts.runtime);
  validateSkillFiles(manifest.files, opts.sourceRoot);
  const paths: string[] = [];
  for (const target of targets) {
    const skillDir = path.join(skillRootForTarget(agentId, target), manifest.name);
    writeSkillDir(skillDir, manifest, opts.sourceRoot);
    paths.push(skillDir);
  }
  return { name: manifest.name, targets, paths };
}

function writeSkillDir(
  skillDir: string,
  manifest: NormalizedSkillManifest,
  sourceRoot: string | undefined,
): void {
  const parent = path.dirname(skillDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(path.join(parent, `.${path.basename(skillDir)}-tmp-`));
  try {
    writeFileSync(path.join(tempDir, "SKILL.md"), manifest.skillMd, { mode: 0o600 });
    for (const file of manifest.files) {
      const relativePath = assertSafeRelativePath(file.path);
      const dest = path.join(tempDir, relativePath);
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      if (file.content !== undefined) {
        writeFileSync(dest, file.content, { mode: 0o600 });
        continue;
      }
      copySafeSourcePath(sourceRoot!, file.sourcePath!, dest);
    }
    rmSync(skillDir, { recursive: true, force: true });
    renameSync(tempDir, skillDir);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

function importVercelInstalledSkills(
  agentId: string,
  tempHome: string,
  targets: SkillInstallTarget[],
): InstalledSkillRecord[] {
  const byName = new Map<string, InstalledSkillRecord>();
  for (const target of targets) {
    const sourceRoot = target === "codex"
      ? path.join(tempHome, ".codex", "skills")
      : path.join(tempHome, ".claude", "skills");
    if (!existsSync(sourceRoot)) continue;
    for (const sourceSkillDir of findSkillDirs(sourceRoot)) {
      const name = assertSafeSkillName(readSkillName(sourceSkillDir));
      const dest = path.join(skillRootForTarget(agentId, target), name);
      copySafeSkillDir(sourceSkillDir, dest);
      const existing = byName.get(name);
      if (existing) {
        existing.targets.push(target);
        existing.paths.push(dest);
      } else {
        byName.set(name, { name, targets: [target], paths: [dest] });
      }
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function findSkillDirs(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 3) return;
    const skillMd = path.join(dir, "SKILL.md");
    if (existsSync(skillMd) && lstatSync(skillMd).isFile()) {
      out.push(dir);
      return;
    }
    let children: string[];
    try {
      children = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const child of children) {
      const childPath = path.join(dir, child);
      try {
        const childStat = lstatSync(childPath);
        if (childStat.isSymbolicLink()) continue;
        if (childStat.isDirectory()) visit(childPath, depth + 1);
      } catch {
        /* skip unreadable entries */
      }
    }
  };
  visit(root, 0);
  return out;
}

function readSkillName(skillDir: string): string {
  const fallback = path.basename(skillDir);
  let raw = "";
  try {
    raw = readFileSync(path.join(skillDir, "SKILL.md"), "utf8").slice(0, 8192);
  } catch {
    return fallback;
  }
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const name = fm?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1];
  return name ? unquote(name).trim() : fallback;
}

function targetsForRuntime(runtime: string | undefined): SkillInstallTarget[] {
  if (runtime === "codex") return ["codex"];
  if (runtime === "claude-code") return ["claude-code"];
  return ["claude-code", "codex"];
}

function normalizeTargets(targets: SkillInstallTarget[]): SkillInstallTarget[] {
  const out: SkillInstallTarget[] = [];
  for (const target of targets) {
    if (target !== "claude-code" && target !== "codex") {
      throw new Error(`unsupported skill target: ${String(target)}`);
    }
    if (!out.includes(target)) out.push(target);
  }
  if (out.length === 0) throw new Error("at least one target runtime is required");
  return out;
}

function normalizeTrustedVercelPackageSpec(packageSpec: string): string {
  const cleaned = packageSpec.trim();
  if (!cleaned) throw new Error("packageSpec is required");
  if (!TRUSTED_VERCEL_PACKAGE_SPECS.has(cleaned)) {
    throw new Error(`unsupported vercel skills packageSpec: ${cleaned}`);
  }
  return cleaned;
}

function validateSkillFiles(files: SkillFileManifest[], sourceRoot: string | undefined): void {
  for (const file of files) {
    assertSafeRelativePath(file.path);
    if (file.content !== undefined) {
      if (Buffer.byteLength(file.content, "utf8") > MAX_INLINE_FILE_BYTES) {
        throw new Error(`skill file too large: ${file.path}`);
      }
      continue;
    }
    if (!sourceRoot || !file.sourcePath) {
      throw new Error(`skill file ${file.path} requires content or sourcePath with sourceRoot`);
    }
    resolveSafeSourcePath(sourceRoot, file.sourcePath);
  }
}

function resolveSafeSourcePath(sourceRoot: string, relativeSourcePath: string): string {
  const safeRelativePath = assertSafeRelativePath(relativeSourcePath);
  const rootReal = realpathSync(sourceRoot);
  const sourcePath = path.resolve(sourceRoot, safeRelativePath);
  if (lstatSync(sourcePath).isSymbolicLink()) {
    throw new Error(`unsafe source path symlink: ${relativeSourcePath}`);
  }
  const sourceReal = realpathSync(sourcePath);
  if (sourceReal !== rootReal && !sourceReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`unsafe source path: ${relativeSourcePath}`);
  }
  return sourceReal;
}

function copySafeSourcePath(sourceRoot: string, relativeSourcePath: string, dest: string): void {
  const source = resolveSafeSourcePath(sourceRoot, relativeSourcePath);
  copyNoSymlinks(source, dest);
}

function copySafeSkillDir(sourceSkillDir: string, dest: string): void {
  const parent = path.dirname(dest);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(path.join(parent, `.${path.basename(dest)}-tmp-`));
  try {
    copyNoSymlinks(sourceSkillDir, tempDir);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tempDir, dest);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

function copyNoSymlinks(source: string, dest: string): void {
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`skill import rejects symlink: ${source}`);
  }
  if (sourceStat.isDirectory()) {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const child of readdirSync(source)) {
      copyNoSymlinks(path.join(source, child), path.join(dest, child));
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`skill import supports only files and directories: ${source}`);
  }
  cpSync(source, dest, { force: true, dereference: false });
}

function skillRootForTarget(agentId: string, target: SkillInstallTarget): string {
  return target === "codex"
    ? path.join(agentCodexHomeDir(agentId), "skills")
    : path.join(agentWorkspaceDir(agentId), ".claude", "skills");
}

function assertSafeSkillName(value: string): string {
  const name = value.trim();
  if (!SAFE_SKILL_NAME.test(name) || name === "." || name === "..") {
    throw new Error(`unsafe skill name: ${JSON.stringify(value)}`);
  }
  return name;
}

function assertSafeRelativePath(value: string): string {
  const normalized = path.normalize(value);
  if (
    !value ||
    path.isAbsolute(value) ||
    normalized === "." ||
    normalized.startsWith("..") ||
    normalized.split(path.sep).includes("..")
  ) {
    throw new Error(`unsafe skill file path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function renderSkillMarkdown(name: string, description?: string): string {
  const desc = description ? `description: "${description.replace(/"/g, '\\"')}"\n` : "";
  return `---\nname: ${name}\n${desc}---\n\n# ${name}\n`;
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function defaultVercelSkillsExecutor(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<void> {
  await execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}
