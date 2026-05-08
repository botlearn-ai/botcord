import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  agentCodexHomeDir,
  agentWorkspaceDir,
} from "./agent-workspace.js";

const MAX_SKILLS = 24;
const MAX_DESCRIPTION_CHARS = 260;
const MAX_SKILL_MD_READ_CHARS = 8192;

export interface SoftSkillEntry {
  name: string;
  path: string;
  source: string;
  description?: string;
  mtimeMs: number;
}

export interface SkillIndexOptions {
  extraDirs?: string[];
  includeGlobal?: boolean;
}

export function defaultSkillDirs(
  agentId: string,
  opts: SkillIndexOptions = {},
): Array<{ dir: string; source: string }> {
  const includeGlobal = opts.includeGlobal !== false;
  const dirs: Array<{ dir: string; source: string }> = [
    {
      dir: path.join(agentWorkspaceDir(agentId), ".claude", "skills"),
      source: "agent-claude",
    },
    {
      dir: path.join(agentCodexHomeDir(agentId), "skills"),
      source: "agent-codex",
    },
  ];

  if (includeGlobal) {
    dirs.push(
      { dir: path.join(homedir(), ".claude", "skills"), source: "global-claude" },
      { dir: path.join(homedir(), ".codex", "skills"), source: "global-codex" },
    );
  }

  const envDirs = parseSkillDirsEnv(process.env.BOTCORD_SKILL_DIRS);
  for (const dir of [...envDirs, ...(opts.extraDirs ?? [])]) {
    dirs.push({ dir, source: "external" });
  }

  return dedupeDirs(dirs);
}

export function scanSoftSkills(
  agentId: string,
  opts: SkillIndexOptions = {},
): SoftSkillEntry[] {
  const byName = new Map<string, SoftSkillEntry>();
  const byPath = new Set<string>();

  for (const root of defaultSkillDirs(agentId, opts)) {
    if (!existsSync(root.dir)) continue;
    let children: string[];
    try {
      children = readdirSync(root.dir);
    } catch {
      continue;
    }

    for (const child of children) {
      const skillDir = path.join(root.dir, child);
      const skillMd = path.join(skillDir, "SKILL.md");
      if (byPath.has(skillMd) || !existsSync(skillMd)) continue;
      byPath.add(skillMd);

      let st;
      try {
        st = statSync(skillMd);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }

      const parsed = parseSkillFile(skillMd, child);
      const existing = byName.get(parsed.name);
      const entry: SoftSkillEntry = {
        name: parsed.name,
        path: skillMd,
        source: root.source,
        description: parsed.description,
        mtimeMs: st.mtimeMs,
      };
      if (!existing || priority(root.source) < priority(existing.source)) {
        byName.set(entry.name, entry);
      }
    }
  }

  return Array.from(byName.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SKILLS);
}

export function buildSoftSkillIndexPrompt(
  agentId: string,
  opts: SkillIndexOptions = {},
): string | null {
  const skills = scanSoftSkills(agentId, opts);
  if (skills.length === 0) return null;

  const lines = [
    "[BotCord Daemon Skill Index]",
    "The daemon scanned these SKILL.md files on disk this turn. This is a soft skill index for runtimes whose native skill registry may not hot-reload during resumed sessions.",
    "If the user's request matches a listed skill and the native skill is not already active, read that SKILL.md file directly and follow its workflow manually. Do not assume this index creates new native tools; use only tools and CLIs that are actually available.",
    "",
  ];

  for (const skill of skills) {
    const desc = skill.description ? ` - ${skill.description}` : "";
    lines.push(`- ${skill.name} (${skill.source}): ${skill.path}${desc}`);
  }

  return lines.join("\n");
}

function parseSkillFile(
  skillMd: string,
  fallbackName: string,
): { name: string; description?: string } {
  let raw = "";
  try {
    raw = readFileSync(skillMd, "utf8").slice(0, MAX_SKILL_MD_READ_CHARS);
  } catch {
    return { name: fallbackName };
  }

  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm?.[1] ?? "";
  const name = readYamlScalar(frontmatter, "name") ?? fallbackName;
  const description =
    readYamlScalar(frontmatter, "description") ??
    readMarkdownDescription(raw) ??
    undefined;

  return {
    name: sanitizeInline(name) || fallbackName,
    description: description ? truncate(sanitizeInline(description), MAX_DESCRIPTION_CHARS) : undefined,
  };
}

function readYamlScalar(frontmatter: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const match = frontmatter.match(re);
  if (!match) return null;
  return unquote(match[1] ?? "");
}

function readMarkdownDescription(raw: string): string | null {
  const purpose = raw.match(/\*\*Purpose:\*\*\s*([^\n]+)/i);
  if (purpose?.[1]) return purpose[1];
  const firstParagraph = raw
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("#"));
  return firstParagraph ?? null;
}

function parseSkillDirsEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupeDirs(
  dirs: Array<{ dir: string; source: string }>,
): Array<{ dir: string; source: string }> {
  const seen = new Set<string>();
  const out: Array<{ dir: string; source: string }> = [];
  for (const entry of dirs) {
    const resolved = path.resolve(entry.dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({ dir: resolved, source: entry.source });
  }
  return out;
}

function priority(source: string): number {
  switch (source) {
    case "agent-claude":
      return 0;
    case "agent-codex":
      return 1;
    case "global-claude":
      return 2;
    case "global-codex":
      return 3;
    default:
      return 4;
  }
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

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
