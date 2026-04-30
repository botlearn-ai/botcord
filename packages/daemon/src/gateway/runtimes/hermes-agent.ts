import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  agentHermesHomeDir,
  agentHermesWorkspaceDir,
  ensureAttachedHermesProfileSkills,
  ensureAgentHermesWorkspace,
} from "../../agent-workspace.js";
import { buildCliEnv } from "../cli-resolver.js";
import {
  AcpRuntimeAdapter,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpUpdateCtx,
  type AcpUpdateParams,
} from "./acp-stream.js";
import {
  firstExistingPath,
  readCommandVersion,
  resolveCommandOnPath,
  resolveHomePath,
  type ProbeDeps,
} from "./probe.js";
import type { RuntimeProbeResult, RuntimeRunOptions, StreamBlock } from "../types.js";

/**
 * Known absolute locations of the `hermes-acp` entry point when it is not on
 * PATH. The upstream `scripts/install.sh` (curl|bash installer) installs a
 * private virtualenv under `~/.hermes/hermes-agent/venv/` and only symlinks
 * the user-facing `hermes` command into `~/.local/bin/` — the `hermes-acp`
 * entry point stays inside the venv. Without a fallback, daemon's PATH-only
 * probe misses every user who installed via the README-recommended script.
 */
const HERMES_ACP_FALLBACK_RELATIVE_PATHS = [
  path.join(".hermes", "hermes-agent", "venv", "bin", "hermes-acp"),
];
const HERMES_ACP_FALLBACK_SYSTEM_PATHS = [
  "/opt/hermes/hermes-agent/venv/bin/hermes-acp",
];

/**
 * Resolve the `hermes-acp` executable. Tries PATH first, then falls back to
 * the upstream install.sh's private venv location (`~/.hermes/...`) before
 * giving up. `BOTCORD_HERMES_AGENT_BIN` always wins via the adapter override.
 */
export function resolveHermesAcpCommand(deps: ProbeDeps = {}): string | null {
  const onPath = resolveCommandOnPath("hermes-acp", deps);
  if (onPath) return onPath;
  return firstExistingPath(
    [
      ...HERMES_ACP_FALLBACK_RELATIVE_PATHS.map((p) => resolveHomePath(p, deps)),
      ...HERMES_ACP_FALLBACK_SYSTEM_PATHS,
    ],
    deps,
  );
}

/** Probe whether `hermes-acp` is installed and report its version. */
export function probeHermesAgent(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveHermesAcpCommand(deps);
  if (!command) return { available: false };
  return {
    available: true,
    path: command,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

/**
 * Discovered hermes profile entry (daemon-side shape; wire shape lives in
 * protocol-core's `HermesProfileProbe`). Occupancy is filled in later by
 * `provision.ts` from local credentials, not here.
 */
export interface HermesProfileInfo {
  name: string;
  home: string;
  isDefault?: boolean;
  isActive?: boolean;
  modelName?: string;
  sessionsCount?: number;
  hasSoul?: boolean;
}

/**
 * Resolve the hermes root (`~/.hermes`) — this is the location of the
 * synthetic `default` profile per upstream's "default profile = HERMES_HOME
 * itself" convention (`hermes_cli/profiles.py:8`).
 */
export function hermesRootDir(): string {
  return path.join(homedir(), ".hermes");
}

/** Profile-name shape mirrors `hermes_cli/profiles.py:_PROFILE_ID_RE`. */
const HERMES_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidHermesProfileName(name: string): boolean {
  return name === "default" || HERMES_PROFILE_NAME_RE.test(name);
}

/**
 * Resolve a hermes profile's HERMES_HOME directory. `default` maps to
 * `~/.hermes`; all other names map to `~/.hermes/profiles/<name>`. Mirrors
 * `hermes_cli/profiles.py:get_profile_dir`.
 */
export function hermesProfileHomeDir(name: string): string {
  if (!isValidHermesProfileName(name)) {
    throw new Error(`Invalid hermes profile name: ${name}`);
  }
  if (name === "default") return hermesRootDir();
  return path.join(hermesRootDir(), "profiles", name);
}

function readActiveProfileName(): string {
  try {
    const raw = readFileSync(path.join(hermesRootDir(), "active_profile"), "utf8").trim();
    return raw || "default";
  } catch {
    return "default";
  }
}

function readProfileModelName(profileHome: string): string | undefined {
  try {
    const raw = readFileSync(path.join(profileHome, "config.yaml"), "utf8");
    // Cheap surface-level YAML peek — config.yaml's first block is
    // `model:\n  default: <name>`. Avoid pulling in a YAML dependency for
    // a single optional field.
    const match = raw.match(/^model:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+default:\s*([^\n#]+)/m);
    if (!match) return undefined;
    return match[1].trim().replace(/^['"]|['"]$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

function countSessions(profileHome: string): number | undefined {
  try {
    const dir = path.join(profileHome, "sessions");
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return undefined;
  }
}

function hasSoul(profileHome: string): boolean {
  return existsSync(path.join(profileHome, "SOUL.md"));
}

/**
 * Enumerate available hermes profiles on this device. Pure local filesystem
 * scan — does not invoke any hermes binary. Returns the synthetic `default`
 * entry first when `~/.hermes` exists (which it should, given that the probe
 * already located `hermes-acp`); each `~/.hermes/profiles/<name>/` directory
 * follows.
 */
export function listHermesProfiles(): HermesProfileInfo[] {
  const out: HermesProfileInfo[] = [];
  const root = hermesRootDir();
  const active = readActiveProfileName();

  if (existsSync(root)) {
    out.push({
      name: "default",
      home: root,
      isDefault: true,
      isActive: active === "default",
      modelName: readProfileModelName(root),
      sessionsCount: countSessions(root),
      hasSoul: hasSoul(root),
    });
  }

  const profilesDir = path.join(root, "profiles");
  let entries: string[] = [];
  try {
    entries = readdirSync(profilesDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!HERMES_PROFILE_NAME_RE.test(name)) continue;
    const home = path.join(profilesDir, name);
    try {
      if (!statSync(home).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({
      name,
      home,
      isActive: active === name,
      modelName: readProfileModelName(home),
      sessionsCount: countSessions(home),
      hasSoul: hasSoul(home),
    });
  }

  return out;
}

/**
 * Hermes Agent adapter. Drives `hermes-acp` (the ACP stdio adapter shipped
 * with `pip install "hermes-agent[acp]"`).
 *
 * ## systemContext injection
 *
 * Hermes discovers `AGENTS.md` from the spawn cwd upward. We point cwd at a
 * runtime-private directory (`~/.botcord/agents/<id>/hermes-workspace/`) and
 * write `<cwd>/AGENTS.md` from `opts.systemContext` before spawn. This is a
 * **first-turn-only** injection: hermes persists the system prompt in the
 * session DB and does not re-read AGENTS.md on continuation turns. The
 * design doc tracks this as a known limitation; a follow-up PR to
 * hermes-agent would expose a per-turn ephemeral prompt channel.
 *
 * ## Per-agent isolation
 *
 * - `HERMES_HOME` → `<agent-home>/hermes-home/` so `.env`, `state.db`,
 *   `skills/` per-agent are isolated from `~/.hermes`.
 * - cwd → `<agent-home>/hermes-workspace/` (NOT the user-editable
 *   `<agent-home>/workspace/`) so each turn's daemon-rewritten AGENTS.md
 *   does not clobber files the user/agent edited.
 *
 * ## Permission policy (trustLevel → ACP outcome)
 *
 * `HERMES_INTERACTIVE=1` makes hermes route dangerous tool calls through the
 * ACP `session/request_permission` reverse-call. We answer per trustLevel:
 *   - `owner`   → always select an `allow_*` option
 *   - `trusted` → same; reasons go to the daemon log only
 *   - `public`  → cancel (DeniedOutcome) for all writes/exec
 */
export class HermesAgentAdapter extends AcpRuntimeAdapter {
  readonly id = "hermes-agent" as const;

  private readonly explicitBinary: string | undefined;
  private resolvedBinary: string | null = null;

  constructor(opts?: { binary?: string }) {
    super();
    this.explicitBinary = opts?.binary ?? process.env.BOTCORD_HERMES_AGENT_BIN;
  }

  probe(): RuntimeProbeResult {
    return probeHermesAgent();
  }

  protected resolveBinary(): string {
    if (this.explicitBinary) return this.explicitBinary;
    if (this.resolvedBinary) return this.resolvedBinary;
    this.resolvedBinary = resolveHermesAcpCommand() ?? "hermes-acp";
    return this.resolvedBinary;
  }

  /**
   * hermes-acp is invoked with no positional args — ACP is pure stdio
   * JSON-RPC. We do not forward `opts.extraArgs` because hermes-acp does
   * not accept CLI flags for runtime config; per-agent config goes in
   * `<HERMES_HOME>/.env`.
   */
  protected buildArgs(_opts: RuntimeRunOptions): string[] {
    return [];
  }

  protected spawnEnv(opts: RuntimeRunOptions): NodeJS.ProcessEnv {
    const cliEnv = buildCliEnv({
      hubUrl: opts.hubUrl,
      accountId: opts.accountId,
      basePath: process.env.PATH,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...cliEnv,
      // Keep ACP stdout free of ANSI codes regardless of terminal settings.
      NO_COLOR: "1",
      // Route dangerous tool calls through ACP request_permission.
      HERMES_INTERACTIVE: "1",
    };
    // Attach mode: BotCord agent shares a hermes profile (state.db /
    // sessions / skills / .env) with the user's command-line `hermes`. In
    // this mode we DO NOT seed a private home — AGENTS.md is written under
    // the per-agent hermes-workspace cwd (NOT into the profile root) by
    // `prepareTurn`, while bundled BotCord skills are installed into the
    // attached profile's `skills/` directory so hermes can discover them.
    if (opts.hermesProfile) {
      env.HERMES_HOME = hermesProfileHomeDir(opts.hermesProfile);
    } else if (opts.accountId) {
      env.HERMES_HOME = agentHermesHomeDir(opts.accountId);
    }
    return env;
  }

  protected sessionCwd(opts: RuntimeRunOptions): string {
    if (opts.accountId) return agentHermesWorkspaceDir(opts.accountId);
    return opts.cwd;
  }

  /**
   * Write systemContext to `<hermes-workspace>/AGENTS.md` atomically before
   * spawn. NOTE: hermes only reads this file on the first turn of a session
   * (see class-level docstring); subsequent turns keep the persisted
   * system prompt and ignore filesystem changes.
   */
  protected prepareTurn(opts: RuntimeRunOptions): void {
    if (!opts.accountId) return;
    const { hermesWorkspace } = ensureAgentHermesWorkspace(opts.accountId, {
      attached: !!opts.hermesProfile,
    });
    if (opts.hermesProfile) {
      ensureAttachedHermesProfileSkills(hermesProfileHomeDir(opts.hermesProfile));
    }
    const target = path.join(hermesWorkspace, "AGENTS.md");
    const tmp = path.join(hermesWorkspace, `.AGENTS.md.${process.pid}.tmp`);
    mkdirSync(hermesWorkspace, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, opts.systemContext ?? "", { mode: 0o600 });
    renameSync(tmp, target);
  }

  /** Spawn with the runtime-private hermes-workspace as cwd. */
  override async run(opts: RuntimeRunOptions) {
    const effective = opts.accountId
      ? { ...opts, cwd: agentHermesWorkspaceDir(opts.accountId) }
      : opts;
    return super.run(effective);
  }

  /**
   * Translate ACP `session/update` notifications into StreamBlocks +
   * assistant text. We surface the common shapes that hermes emits:
   *   - `agent_message_chunk` / `user_message_chunk` content blocks
   *   - `tool_call` / `tool_call_update`
   *   - `agent_thought_chunk` (status-only — see below)
   *
   * `agent_thought_chunk` deliberately maps to ONLY a `thinking.updated`
   * status event, NOT a block: the underlying ACP payload has no `subtype`
   * / `session_id` / `model` fields that `normalizeBlockForHub("system")`
   * would render, so emitting a `kind:"system"` block here just produces an
   * empty payload alongside the labeled thinking frame. Anything else is
   * forwarded as `kind: "other"` so subclasses / downstream channels can
   * introspect.
   */
  protected onUpdate(params: AcpUpdateParams, ctx: AcpUpdateCtx): void {
    const update = params.update ?? {};
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    if (kind === "agent_thought_chunk") {
      ctx.emitStatus({ kind: "thinking", phase: "updated", label: "Thinking" });
      return;
    }

    let blockKind: StreamBlock["kind"] = "other";
    let assistantTextSeen = false;

    if (kind === "agent_message_chunk") {
      const content = (update as { content?: { type?: string; text?: string } })
        .content;
      if (content && content.type === "text" && typeof content.text === "string") {
        ctx.appendAssistantText(content.text);
        assistantTextSeen = content.text.length > 0;
      }
      blockKind = "assistant_text";
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      blockKind = "tool_use";
    } else if (kind === "user_message_chunk") {
      blockKind = "other";
    }

    // Status hint BEFORE the block so the dispatcher's auto-synthesis sees a
    // labeled `thinking.updated`/`stopped` instead of a bare `started`.
    const status = hermesStatusEvent(kind, update, assistantTextSeen);
    if (status) ctx.emitStatus(status);

    ctx.emitBlock({ raw: params, kind: blockKind, seq: ctx.seq });
  }

  /**
   * trustLevel-driven policy. We pick the FIRST option whose `kind` matches
   * our intent — `allow_*` for permit, otherwise cancel. ACP's
   * DeniedOutcome carries no `optionId` / `reason` field; rationale lives
   * in the daemon log.
   */
  protected async onPermissionRequest(
    req: AcpPermissionRequest,
    opts: RuntimeRunOptions,
  ): Promise<AcpPermissionResponse> {
    const options = Array.isArray(req.options) ? req.options : [];
    const trust = opts.trustLevel;

    if (trust === "owner" || trust === "trusted") {
      const allow =
        options.find((o) => typeof o.kind === "string" && o.kind.startsWith("allow_")) ??
        options[0];
      if (allow?.optionId) {
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
      return { outcome: { outcome: "cancelled" } };
    }

    // public: deny everything that requires explicit approval
    return { outcome: { outcome: "cancelled" } };
  }
}

/**
 * Map an ACP `session/update` payload to a `RuntimeStatusEvent`. We only
 * return events that add a label or convey a transition the dispatcher
 * cannot infer from block kinds — the auto-synthesis path covers the rest.
 */
function hermesStatusEvent(
  kind: string,
  update: { content?: { type?: string; text?: string }; toolCall?: { name?: string } } & Record<
    string,
    unknown
  >,
  assistantTextSeen: boolean,
): import("../types.js").RuntimeStatusEvent | undefined {
  // `agent_thought_chunk` is handled inline in `onUpdate` (status-only path).
  if (kind === "tool_call" || kind === "tool_call_update") {
    const tool = (update as { toolCall?: { name?: string } }).toolCall;
    const name = typeof tool?.name === "string" && tool.name ? tool.name : "tool";
    return { kind: "thinking", phase: "updated", label: name };
  }
  if (kind === "agent_message_chunk" && assistantTextSeen) {
    return { kind: "thinking", phase: "stopped" };
  }
  return undefined;
}
