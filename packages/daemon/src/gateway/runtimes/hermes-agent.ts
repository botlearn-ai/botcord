import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  agentHermesHomeDir,
  agentHermesWorkspaceDir,
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
    if (opts.accountId) {
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
    const { hermesWorkspace } = ensureAgentHermesWorkspace(opts.accountId);
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
   *   - `agent_thought_chunk`
   *
   * Anything else is forwarded as `kind: "other"` so subclasses /
   * downstream channels can introspect.
   */
  protected onUpdate(params: AcpUpdateParams, ctx: AcpUpdateCtx): void {
    const update = params.update ?? {};
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    let blockKind: StreamBlock["kind"] = "other";

    if (kind === "agent_message_chunk") {
      const content = (update as { content?: { type?: string; text?: string } })
        .content;
      if (content && content.type === "text" && typeof content.text === "string") {
        ctx.appendAssistantText(content.text);
      }
      blockKind = "assistant_text";
    } else if (kind === "agent_thought_chunk") {
      blockKind = "system";
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      blockKind = "tool_use";
    } else if (kind === "user_message_chunk") {
      blockKind = "other";
    }

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
