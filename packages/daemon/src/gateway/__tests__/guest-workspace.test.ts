import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const fakeHome = mkdtempSync(path.join(tmpdir(), "botcord-guest-ws-test-"));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => fakeHome };
});

const { commitGuestChanges, ensureGuestWorkspace, guestWorkspaceDir } = await import(
  "../guest-workspace.js"
);

function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "botcord-guest-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  git("init", "-q");
  writeFileSync(path.join(repo, "a.txt"), "hello\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return repo;
}

describe("guest workspace", () => {
  it("creates a per-grant worktree and commits collaborator changes on its branch", async () => {
    const repo = makeRepo();
    const ws = await ensureGuestWorkspace({ agentId: "ag_barry", grantId: "grant-1", workspacePath: repo });
    expect(ws).toEqual({ dir: guestWorkspaceDir("ag_barry", "grant-1"), kind: "worktree", branch: "guest/grant1" });
    expect(readFileSync(path.join(ws.dir, "a.txt"), "utf8")).toBe("hello\n");

    expect(await commitGuestChanges(ws, { requesterId: "hu_alice", request: "noop" })).toBeNull();

    writeFileSync(path.join(ws.dir, "a.txt"), "hello world\n");
    const summary = await commitGuestChanges(ws, { requesterId: "hu_alice", request: "改一下 a.txt" });
    expect(summary).toContain("guest/grant1");
    expect(summary).toContain("1 file changed");
    const log = execFileSync("git", ["-C", repo, "log", "--format=%s|%an", "guest/grant1", "-1"]).toString();
    expect(log.trim()).toBe("guest(hu_alice): 改一下 a.txt|BotCord guest hu_alice");
    // The owner's checkout is untouched.
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("hello\n");

    const again = await ensureGuestWorkspace({ agentId: "ag_barry", grantId: "grant-1", workspacePath: repo });
    expect(again.kind).toBe("worktree");
  });

  it("falls back to a scratch directory without a git repository", async () => {
    const ws = await ensureGuestWorkspace({ agentId: "ag_barry", grantId: "grant-2", workspacePath: null });
    expect(ws.kind).toBe("scratch");
    expect(existsSync(ws.dir)).toBe(true);
    expect(await commitGuestChanges(ws, { requesterId: "hu_alice", request: "x" })).toBeNull();

    const notRepo = mkdtempSync(path.join(tmpdir(), "botcord-not-repo-"));
    const ws3 = await ensureGuestWorkspace({ agentId: "ag_barry", grantId: "grant-3", workspacePath: notRepo });
    expect(ws3.kind).toBe("scratch");
  });
});
