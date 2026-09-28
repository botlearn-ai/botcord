/**
 * Per-grant workspace for agent-sharing collaborators.
 *
 * A collaborator never runs in the agent's own workspace. When the grant names
 * an owner-side git repository, the daemon creates a dedicated worktree on
 * branch `guest/<grant>` and commits the collaborator's changes there after
 * every turn, so the owner reviews and merges them like any other branch.
 * Without a repository the collaborator gets an empty private scratch dir.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { agentHomeDir } from "../agent-workspace.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

export interface GuestWorkspace {
  dir: string;
  kind: "worktree" | "scratch";
  branch?: string;
}

function shortGrant(grantId: string): string {
  return grantId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "grant";
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Directory holding this grant's workspace (not created). */
export function guestWorkspaceDir(agentId: string, grantId: string): string {
  return path.join(agentHomeDir(agentId), "guests", shortGrant(grantId), "work");
}

/**
 * Ensure the grant's workspace exists and return it. A repository path that is
 * not an absolute git work tree falls back to a scratch directory.
 */
export async function ensureGuestWorkspace(opts: {
  agentId: string;
  grantId: string;
  workspacePath: string | null;
}): Promise<GuestWorkspace> {
  const dir = guestWorkspaceDir(opts.agentId, opts.grantId);
  const branch = `guest/${shortGrant(opts.grantId)}`;
  const repo = opts.workspacePath ? expandHome(opts.workspacePath) : null;

  if (existsSync(dir)) {
    const isWorktree = existsSync(path.join(dir, ".git"));
    return isWorktree ? { dir, kind: "worktree", branch } : { dir, kind: "scratch" };
  }
  if (repo && path.isAbsolute(repo)) {
    try {
      const top = await git(["-C", repo, "rev-parse", "--show-toplevel"]);
      mkdirSync(path.dirname(dir), { recursive: true });
      await git(["-C", top, "worktree", "add", "-B", branch, dir, "HEAD"]);
      return { dir, kind: "worktree", branch };
    } catch {
      // Not a git repository (or worktree creation failed): use scratch.
    }
  }
  mkdirSync(dir, { recursive: true });
  return { dir, kind: "scratch" };
}

/**
 * Commit whatever the collaborator changed in a worktree workspace. Returns a
 * short human-readable summary, or null when nothing changed / not a worktree.
 */
export async function commitGuestChanges(
  ws: GuestWorkspace,
  opts: { requesterId: string; request: string },
): Promise<string | null> {
  if (ws.kind !== "worktree") return null;
  const status = await git(["-C", ws.dir, "status", "--porcelain"]);
  if (!status) return null;
  const subject = opts.request.replace(/\s+/g, " ").trim().slice(0, 60) || "update";
  await git(["-C", ws.dir, "add", "-A"]);
  await git([
    "-C",
    ws.dir,
    "-c",
    `user.name=BotCord guest ${opts.requesterId}`,
    "-c",
    "user.email=guest@botcord.local",
    "commit",
    "--no-verify",
    "-m",
    `guest(${opts.requesterId}): ${subject}`,
  ]);
  const stat = await git(["-C", ws.dir, "show", "--stat", "--format=%h", "HEAD"]);
  const [sha, ...lines] = stat.split("\n").filter(Boolean);
  const summary = lines[lines.length - 1]?.trim() ?? "";
  return `已提交到分支 \`${ws.branch}\`（${sha}）：${summary}`;
}
