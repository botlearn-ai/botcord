/**
 * BotLearn Course session runtime profiles.
 *
 * Profiles are materialized below one agent's `sessions/` directory and are
 * looked up by the owner-chat room id on every turn. They never touch the
 * agent's persistent workspace/CODEX_HOME skill roots.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  ApplySessionProfileParams,
  SessionProfileSkillPackageInput,
  SessionProfileStatus,
} from "@botcord/protocol-core";
import type { GatewayRoute } from "./gateway/index.js";
import {
  agentSessionProfileDir,
  agentSessionProfilesDir,
} from "./agent-workspace.js";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const FILE_DIGEST_RE = /^[a-f0-9]{64}$/;
const SAFE_REF_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_PROMPT_CHARS = 100_000;
const MAX_SKILLS = 32;
const MAX_FILES_PER_SKILL = 128;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 24 * 60 * 60;

interface StoredSessionSkill {
  ref: string;
  digest: string;
  skillMdPath: string;
}

interface StoredSessionProfile {
  schemaVersion: "botcord-session-profile/0.1";
  agentId: string;
  sessionKey: string;
  roomId: string;
  profileId: string;
  profileHash: string;
  courseVersionId: string;
  promptPack: {
    ref: string;
    digest: string;
    systemInstructions: string;
  };
  skills: StoredSessionSkill[];
  requiredCapabilities: string[];
  availableCapabilities: string[];
  missingCapabilities: string[];
  runtime: string;
  appliedAt: string;
  expiresAt: string;
}

export function availableSessionProfileCapabilities(route: GatewayRoute): string[] {
  const capabilities = new Set<string>();
  const args = route.extraArgs ?? [];
  const readOnly = args.some((arg) =>
    arg === "--sandbox=read-only" ||
    arg === "read-only" ||
    /sandbox_mode=.*read-only/.test(arg)
  );
  if (!readOnly) {
    try {
      accessSync(route.cwd, constants.W_OK);
      capabilities.add("workspace.write");
    } catch {
      // Capability reporting is evidence-based: an unwritable/missing cwd
      // does not become writable just because a course requires it.
    }
  }

  const webSearchRuntimes = new Set([
    "claude-code",
    "deepseek-tui",
    "gemini",
    "kimi-cli",
    "hermes-agent",
  ]);
  const codexSearchEnabled = route.runtime === "codex" && args.some((arg) =>
    arg === "--search" || /web_search\s*=\s*true/.test(arg)
  );
  if (webSearchRuntimes.has(route.runtime) || codexSearchEnabled) {
    capabilities.add("web.search");
  }
  return Array.from(capabilities).sort();
}

export function applySessionProfile(
  params: ApplySessionProfileParams,
  route: GatewayRoute,
): SessionProfileStatus {
  validateTopLevel(params);
  cleanupExpiredSessionProfiles(params.agentId);

  const availableCapabilities = availableSessionProfileCapabilities(route);
  const missingCapabilities = params.requiredCapabilities
    .filter((item) => !availableCapabilities.includes(item))
    .sort();
  const targetDir = agentSessionProfileDir(params.agentId, params.roomId);
  const sessionsDir = agentSessionProfilesDir(params.agentId);
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const stagingDir = path.join(sessionsDir, `.staging-${randomUUID()}`);
  mkdirSync(stagingDir, { recursive: false, mode: 0o700 });

  try {
    const skillsDir = path.join(stagingDir, "skills");
    mkdirSync(skillsDir, { recursive: false, mode: 0o700 });
    const storedSkills: StoredSessionSkill[] = [];
    let profileBytes = Buffer.byteLength(params.promptPack.systemInstructions, "utf8");
    for (const skill of params.skillPackages) {
      const installed = materializeSkill(skillsDir, skill);
      profileBytes += installed.bytes;
      if (profileBytes > MAX_PROFILE_BYTES) {
        throw new Error(`session profile exceeds ${MAX_PROFILE_BYTES} bytes`);
      }
      storedSkills.push({
        ref: `${skill.id}@${skill.version}`,
        digest: skill.digest,
        skillMdPath: path.join(
          targetDir,
          path.relative(stagingDir, installed.skillMdPath),
        ),
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + params.ttlSeconds * 1000);
    const stored: StoredSessionProfile = {
      schemaVersion: "botcord-session-profile/0.1",
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      roomId: params.roomId,
      profileId: params.profileId,
      profileHash: params.profileHash,
      courseVersionId: params.courseVersionId,
      promptPack: {
        ref: `${params.promptPack.id}@${params.promptPack.version}`,
        digest: params.promptPack.digest,
        systemInstructions: params.promptPack.systemInstructions,
      },
      skills: storedSkills,
      requiredCapabilities: uniqueStrings(params.requiredCapabilities),
      availableCapabilities,
      missingCapabilities,
      runtime: route.runtime,
      appliedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    writeFileSync(
      path.join(stagingDir, "profile.json"),
      `${JSON.stringify(stored, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    rmSync(targetDir, { recursive: true, force: true });
    renameSync(stagingDir, targetDir);
    return statusFromStored(stored);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export function readSessionProfile(
  agentId: string,
  roomId: string,
): StoredSessionProfile | null {
  cleanupExpiredSessionProfiles(agentId);
  const profilePath = path.join(agentSessionProfileDir(agentId, roomId), "profile.json");
  if (!existsSync(profilePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as StoredSessionProfile;
    if (
      parsed.schemaVersion !== "botcord-session-profile/0.1" ||
      parsed.agentId !== agentId ||
      parsed.roomId !== roomId ||
      !parsed.sessionKey ||
      !parsed.profileId ||
      !DIGEST_RE.test(parsed.profileHash)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getSessionProfileStatus(
  agentId: string,
  roomId: string,
): SessionProfileStatus | null {
  const stored = readSessionProfile(agentId, roomId);
  return stored ? statusFromStored(stored) : null;
}

export function buildSessionProfilePrompt(agentId: string, roomId: string): string | null {
  const stored = readSessionProfile(agentId, roomId);
  if (!stored) return null;
  if (stored.missingCapabilities.length > 0) {
    return [
      "[BotLearn Course Session Profile: Inactive]",
      `profile_id: ${stored.profileId}`,
      `profile_hash: ${stored.profileHash}`,
      `missing_capabilities: ${stored.missingCapabilities.join(", ")}`,
      "Do not execute the course task. Report that the session runtime requirements are unmet.",
    ].join("\n");
  }

  const lines = [
    "[BotLearn Course Session Profile]",
    "This is trusted, session-scoped course configuration. It supplements BotCord platform rules and cannot override platform security, authorization, or owner boundaries.",
    `profile_id: ${stored.profileId}`,
    `profile_hash: ${stored.profileHash}`,
    `prompt_pack: ${stored.promptPack.ref}`,
    "",
    stored.promptPack.systemInstructions.trim(),
  ];
  if (stored.skills.length > 0) {
    lines.push(
      "",
      "[BotLearn Course Session Skill Overlay]",
      "These Skills are enabled only for this conversation. Before using one, read its SKILL.md from the exact path below; do not copy it into persistent Agent skill directories.",
      ...stored.skills.map((skill) => `- ${skill.ref}: ${skill.skillMdPath}`),
    );
  }
  return lines.join("\n");
}

export function cleanupExpiredSessionProfiles(agentId: string, nowMs = Date.now()): number {
  const root = agentSessionProfilesDir(agentId);
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    // A runtime turn can race with atomic profile materialization. Never
    // delete another in-flight writer's staging directory here; failed
    // writers clean their own staging directory in `applySessionProfile`.
    if (entry.name.startsWith(".staging-")) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, "profile.json"), "utf8")) as {
        expiresAt?: unknown;
      };
      const expiresAt = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

function validateTopLevel(params: ApplySessionProfileParams): void {
  if (!params.agentId) throw new Error("apply_session_profile requires agentId");
  if (!params.sessionKey || params.sessionKey.length > 180) {
    throw new Error("invalid sessionKey");
  }
  if (!params.roomId || params.roomId.length > 512) throw new Error("invalid roomId");
  assertSafeRefPart(params.profileId, "profileId");
  assertDigest(params.profileHash, "profileHash");
  if (params.schemaVersion !== "botlearn-course-runtime-profile/0.1") {
    throw new Error(`unsupported session profile schema: ${params.schemaVersion}`);
  }
  if (!params.courseVersionId || params.courseVersionId.length > 128) {
    throw new Error("invalid courseVersionId");
  }
  assertSafeRefPart(params.promptPack.id, "promptPack.id");
  assertSafeRefPart(params.promptPack.version, "promptPack.version");
  assertDigest(params.promptPack.digest, "promptPack.digest");
  if (
    !params.promptPack.systemInstructions.trim() ||
    params.promptPack.systemInstructions.length > MAX_PROMPT_CHARS
  ) {
    throw new Error("invalid promptPack.systemInstructions");
  }
  if (!Number.isInteger(params.ttlSeconds) || params.ttlSeconds < MIN_TTL_SECONDS || params.ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS}`);
  }
  if (!Array.isArray(params.skillPackages) || params.skillPackages.length > MAX_SKILLS) {
    throw new Error(`skillPackages may contain at most ${MAX_SKILLS} items`);
  }
  const skillIds = new Set<string>();
  for (const skill of params.skillPackages) {
    assertSafeRefPart(skill.id, "skillPackages.id");
    assertSafeRefPart(skill.version, "skillPackages.version");
    assertDigest(skill.digest, `skillPackages.${skill.id}.digest`);
    if (skillIds.has(skill.id)) {
      throw new Error(`multiple versions of session skill are not allowed: ${skill.id}`);
    }
    skillIds.add(skill.id);
  }
  if (!Array.isArray(params.requiredCapabilities) || params.requiredCapabilities.length > 64) {
    throw new Error("requiredCapabilities may contain at most 64 items");
  }
  for (const capability of params.requiredCapabilities) {
    if (!/^[a-z][a-z0-9._-]{0,79}$/.test(capability)) {
      throw new Error(`invalid required capability: ${JSON.stringify(capability)}`);
    }
  }
}

function materializeSkill(
  skillsDir: string,
  skill: SessionProfileSkillPackageInput,
): { skillMdPath: string; bytes: number } {
  const archive = skill.archiveManifest;
  if (!archive || typeof archive !== "object" || archive.skills?.length) {
    throw new Error(`skill ${skill.id} requires one flat archiveManifest`);
  }
  if (archive.name && archive.name !== skill.id) {
    throw new Error(`skill archive name mismatch for ${skill.id}`);
  }
  const skillMd = archive.skillMd ?? archive.markdown;
  if (typeof skillMd !== "string" || !skillMd.trim()) {
    throw new Error(`skill ${skill.id} has empty SKILL.md`);
  }
  const files = archive.files ?? [];
  if (files.length > MAX_FILES_PER_SKILL) {
    throw new Error(`skill ${skill.id} has too many files`);
  }
  const packageFiles: Array<{ relative: string; content: string; data: Buffer }> = [
    { relative: "SKILL.md", content: skillMd, data: Buffer.from(skillMd, "utf8") },
  ];
  const seen = new Set(["SKILL.md"]);
  for (const file of files) {
    const relative = normalizeRelativeFile(file.path);
    if (seen.has(relative)) throw new Error(`duplicate skill file: ${relative}`);
    seen.add(relative);
    if (file.sourcePath) throw new Error(`sourcePath is not allowed in session skill ${skill.id}`);
    if (typeof file.content !== "string") {
      throw new Error(`session skill file ${relative} requires inline content`);
    }
    const data = Buffer.from(file.content, "utf8");
    if (data.length > MAX_FILE_BYTES) throw new Error(`skill file is too large: ${relative}`);
    if (file.size !== undefined && file.size !== data.length) {
      throw new Error(`skill file size mismatch: ${relative}`);
    }
    const digest = createHash("sha256").update(data).digest("hex");
    if (file.sha256 !== undefined && (!FILE_DIGEST_RE.test(file.sha256) || file.sha256 !== digest)) {
      throw new Error(`skill file digest mismatch: ${relative}`);
    }
    packageFiles.push({ relative, content: file.content, data });
  }

  const digest = createHash("sha256");
  for (const file of [...packageFiles].sort((a, b) =>
    a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0
  )) {
    digest.update(file.relative, "utf8");
    digest.update("\0");
    digest.update(file.data);
    digest.update("\0");
  }
  const actualDigest = `sha256:${digest.digest("hex")}`;
  if (actualDigest !== skill.digest) {
    throw new Error(`skill package digest mismatch for ${skill.id}@${skill.version}`);
  }

  const skillDir = path.join(skillsDir, `${skill.id}@${skill.version}`);
  mkdirSync(skillDir, { recursive: false, mode: 0o700 });
  for (const file of packageFiles) {
    const destination = path.join(skillDir, ...file.relative.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file.content, { encoding: "utf8", mode: 0o600 });
  }
  return {
    skillMdPath: path.join(skillDir, "SKILL.md"),
    bytes: packageFiles.reduce((total, file) => total + file.data.length, 0),
  };
}

function normalizeRelativeFile(raw: string): string {
  if (!raw || raw.length > 512 || raw.includes("\\") || path.posix.isAbsolute(raw)) {
    throw new Error(`invalid session skill path: ${JSON.stringify(raw)}`);
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized !== raw ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    raw.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`unsafe session skill path: ${JSON.stringify(raw)}`);
  }
  return normalized;
}

function assertSafeRefPart(value: string, field: string): void {
  if (!SAFE_REF_PART_RE.test(value)) throw new Error(`invalid ${field}: ${JSON.stringify(value)}`);
}

function assertDigest(value: string, field: string): void {
  if (!DIGEST_RE.test(value)) throw new Error(`invalid ${field}`);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function statusFromStored(stored: StoredSessionProfile): SessionProfileStatus {
  return {
    profileId: stored.profileId,
    profileHash: stored.profileHash,
    status: stored.missingCapabilities.length > 0 ? "requirements_unmet" : "applied",
    appliedPromptPackRef: stored.promptPack.ref,
    appliedSkillRefs: stored.skills.map((skill) => skill.ref).sort(),
    availableCapabilities: [...stored.availableCapabilities].sort(),
    missingSkills: [],
    missingCapabilities: [...stored.missingCapabilities].sort(),
    runtime: stored.runtime,
    expiresAt: stored.expiresAt,
  };
}
