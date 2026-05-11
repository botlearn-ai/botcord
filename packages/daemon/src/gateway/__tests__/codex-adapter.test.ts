import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../runtimes/codex.js";
import { agentCodexHomeDir } from "../../agent-workspace.js";

// The adapter spawns whatever binary we point it at; we point it at a small
// Node script so we control stdout/stderr/exit precisely without needing the
// real `codex` CLI.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-codex-"));

// Isolate per-agent workspace writes — agent-workspace.ts resolves paths via
// `os.homedir()`, which on POSIX follows `process.env.HOME`. Redirecting it
// to `tmpRoot` keeps these tests from scribbling on `~/.botcord/`.
const originalHome = process.env.HOME;
const agentHomeRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-codex-home-"));

beforeAll(() => {
  process.env.HOME = agentHomeRoot;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(agentHomeRoot, { recursive: true, force: true });
});

function makeScript(name: string, body: string): string {
  const p = path.join(tmpRoot, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

function runAdapter(script: string, sessionId: string | null = null) {
  const adapter = new CodexAdapter({ binary: script });
  const ctrl = new AbortController();
  return adapter.run({
    text: "hi",
    sessionId,
    accountId: "ag_test",
    cwd: tmpRoot,
    signal: ctrl.signal,
    trustLevel: "owner",
  });
}

describe("CodexAdapter", () => {
  it("parses final agent_message text and persists thread_id as newSessionId", async () => {
    const script = makeScript(
      "happy.js",
      `
const lines = [
  {type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcdef"},
  {type:"turn.started"},
  {type:"item.completed", item:{id:"i0", type:"agent_message", text:"hello from codex"}},
  {type:"turn.completed", usage:{input_tokens:1, output_tokens:2}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
process.exit(0);
`,
    );
    const res = await runAdapter(script);
    // Resume is now safe (systemContext lives in AGENTS.md, not transcript),
    // so thread_id IS persisted for the next turn.
    expect(res.newSessionId).toBe("01234567-89ab-7def-8123-456789abcdef");
    expect(res.text).toBe("hello from codex");
    expect(res.error).toBeUndefined();
  });

  it("emits tool_use StreamBlock for command_execution items", async () => {
    const script = makeScript(
      "toolblock.js",
      `
const lines = [
  {type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcde0"},
  {type:"item.started", item:{id:"i0", type:"command_execution", command:"ls"}},
  {type:"item.completed", item:{id:"i1", type:"agent_message", text:"done"}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const adapter = new CodexAdapter({ binary: script });
    const ctrl = new AbortController();
    const seen: string[] = [];
    const res = await adapter.run({
      text: "x",
      sessionId: null,
      accountId: "ag_test",
      cwd: tmpRoot,
      signal: ctrl.signal,
      trustLevel: "owner",
      onBlock: (b) => seen.push(b.kind),
    });
    expect(res.text).toBe("done");
    expect(seen).toContain("tool_use");
    expect(seen).toContain("assistant_text");
    expect(seen).toContain("system");
  });

  it("emits thinking onStatus events for thread.started, turn.started, tool item, and assistant_message", async () => {
    const script = makeScript(
      "thinkflow.js",
      `
const lines = [
  {type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcde2"},
  {type:"turn.started"},
  {type:"item.started", item:{id:"i0", type:"web_search", query:"x"}},
  {type:"item.completed", item:{id:"i1", type:"agent_message", text:"ok"}},
  {type:"turn.completed", usage:{}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const adapter = new CodexAdapter({ binary: script });
    const ctrl = new AbortController();
    const status: Array<{ phase: string; label?: string }> = [];
    await adapter.run({
      text: "x",
      sessionId: null,
      accountId: "ag_test",
      cwd: tmpRoot,
      signal: ctrl.signal,
      trustLevel: "owner",
      onStatus: (e) => {
        if (e.kind === "thinking") {
          status.push({ phase: e.phase, label: e.label });
        }
      },
    });
    // thread.started → started/Starting session
    // turn.started → started/Thinking
    // item.started(web_search) → updated/Searching web
    // item.completed(agent_message) → stopped
    // turn.completed → stopped
    expect(status).toEqual([
      { phase: "started", label: "Starting session" },
      { phase: "started", label: "Thinking" },
      { phase: "updated", label: "Searching web" },
      { phase: "stopped", label: undefined },
      { phase: "stopped", label: undefined },
    ]);
  });

  it("no sessionId → `exec` subcommand (no resume)", async () => {
    const script = makeScript(
      "fresh-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcde1"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"i0", type:"agent_message", text:JSON.stringify(argv)}}) + "\\n");
`,
    );
    const res = await runAdapter(script, null);
    const argv = JSON.parse(res.text) as string[];
    expect(argv[0]).toBe("exec");
    expect(argv[1]).not.toBe("resume");
  });

  it("with sessionId → `exec resume <uuid>` subcommand", async () => {
    const script = makeScript(
      "resume-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcde2"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"i0", type:"agent_message", text:JSON.stringify(argv)}}) + "\\n");
`,
    );
    const uuid = "01234567-89ab-7def-8123-456789abcdef";
    const res = await runAdapter(script, uuid);
    const argv = JSON.parse(res.text) as string[];
    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe("resume");
    expect(argv[2]).toBe(uuid);
    // Sandbox policy uses `-c` overrides (resume doesn't accept `-s`).
    expect(argv).not.toContain("-s");
  });

  it("rejects non-UUID sessionId before spawn", async () => {
    const script = makeScript("noop.js", "process.exit(0);");
    const adapter = new CodexAdapter({ binary: script });
    const ctrl = new AbortController();
    await expect(
      adapter.run({
        text: "x",
        sessionId: "--not-a-uuid",
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "owner",
      }),
    ).rejects.toThrow(/invalid sessionId/);
  });

  it("writes systemContext to <CODEX_HOME>/AGENTS.md atomically before spawn", async () => {
    // Capture CODEX_HOME seen by the child so we can verify the adapter's env.
    const script = makeScript(
      "echo-codex-home.js",
      `
const home = process.env.CODEX_HOME ?? "";
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcde3"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"i0", type:"agent_message", text: home}}) + "\\n");
`,
    );
    const adapter = new CodexAdapter({ binary: script });
    const ctrl = new AbortController();
    const res = await adapter.run({
      text: "do the thing",
      sessionId: null,
      accountId: "ag_codex_test",
      cwd: tmpRoot,
      signal: ctrl.signal,
      trustLevel: "owner",
      systemContext: "MEMORY: remember X\nDIGEST: room Y was active",
    });
    const expectedHome = agentCodexHomeDir("ag_codex_test");
    expect(res.text).toBe(expectedHome);
    const agentsMd = path.join(expectedHome, "AGENTS.md");
    expect(existsSync(agentsMd)).toBe(true);
    const body = readFileSync(agentsMd, "utf8");
    expect(body).toContain("MEMORY: remember X");
    expect(body).toContain("DIGEST: room Y was active");
    // No tmp leftovers from the atomic rename.
    const stray = path.join(expectedHome, `.AGENTS.md.${process.pid}.tmp`);
    expect(existsSync(stray)).toBe(false);
  });

  it("does NOT prepend systemContext to the positional prompt", async () => {
    const script = makeScript(
      "echo-prompt.js",
      `
const argv = process.argv.slice(2);
const dashIdx = argv.indexOf("--");
const prompt = dashIdx >= 0 ? argv.slice(dashIdx + 1).join(" ") : "";
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcde4"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"i0", type:"agent_message", text: prompt}}) + "\\n");
`,
    );
    const adapter = new CodexAdapter({ binary: script });
    const ctrl = new AbortController();
    const res = await adapter.run({
      text: "do the thing",
      sessionId: null,
      accountId: "ag_test",
      cwd: tmpRoot,
      signal: ctrl.signal,
      trustLevel: "owner",
      systemContext: "MEMORY: remember X",
    });
    expect(res.text).toBe("do the thing");
    expect(res.text).not.toContain("MEMORY:");
    expect(res.text).not.toContain("---");
  });

  it("returns early when signal is already aborted", async () => {
    const script = makeScript("noop.js", "process.exit(0);");
    const adapter = new CodexAdapter({ binary: script });
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await adapter.run({
      text: "x",
      sessionId: null,
      accountId: "ag_test",
      cwd: tmpRoot,
      signal: ctrl.signal,
      trustLevel: "owner",
    });
    expect(res.text).toBe("");
    expect(res.error).toMatch(/aborted before spawn/);
  });

  it("surfaces turn.completed failure message as error", async () => {
    const script = makeScript(
      "failed.js",
      `
const lines = [
  {type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcde5"},
  {type:"turn.completed", turn:{status:"failed", error:{message:"rate limited"}}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const res = await runAdapter(script);
    expect(res.error).toMatch(/rate limited/);
  });

  it("surfaces non-zero exit + stderr as error", async () => {
    const script = makeScript(
      "boom.js",
      `
process.stderr.write("codex: auth required\\n");
process.exit(3);
`,
    );
    const res = await runAdapter(script);
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/code 3/);
    expect(res.error).toMatch(/auth required/);
  });

  describe("trustLevel → sandbox defaults (expressed as `-c` so `resume` accepts them)", () => {
    // Echo argv back via the same `thread.started` / `agent_message` shape
    // so we can assert on the flags the adapter chose.
    const echoScript = () =>
      makeScript(
        "echo-argv.js",
        `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"01234567-89ab-7def-8123-456789abcdea"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"i0", type:"agent_message", text: JSON.stringify(argv)}}) + "\\n");
`,
      );

    it("owner → sandbox_mode=\"danger-full-access\" + approval_policy=\"never\"", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "owner",
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).toContain('sandbox_mode="danger-full-access"');
      expect(argv).toContain('approval_policy="never"');
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain("-s");
    });

    it("public → sandbox_mode=\"danger-full-access\" + approval_policy=\"never\"", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).toContain('sandbox_mode="danger-full-access"');
      expect(argv).toContain('approval_policy="never"');
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("trusted → sandbox_mode=\"danger-full-access\" + approval_policy=\"never\"", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "trusted",
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).toContain('sandbox_mode="danger-full-access"');
      expect(argv).toContain('approval_policy="never"');
    });

    it("extraArgs `-s read-only` is converted to resume-compatible sandbox config", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
        extraArgs: ["-s", "read-only"],
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).not.toContain("-s");
      expect(argv).toContain('sandbox_mode="read-only"');
      expect(argv).not.toContain('sandbox_mode="workspace-write"');
      expect(argv).not.toContain('sandbox_mode="danger-full-access"');
    });

    it("extraArgs `--sandbox=value` is converted on resume too", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: "01234567-89ab-7def-8123-456789abcdef",
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
        extraArgs: ["--sandbox=workspace-write"],
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv[0]).toBe("exec");
      expect(argv[1]).toBe("resume");
      expect(argv).not.toContain("--sandbox=workspace-write");
      expect(argv).toContain('sandbox_mode="workspace-write"');
      expect(argv).not.toContain('sandbox_mode="danger-full-access"');
    });

    it("maps legacy Codex --full-auto to the current bypass flag", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
        extraArgs: ["--full-auto"],
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).not.toContain("--full-auto");
      expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain('sandbox_mode="danger-full-access"');
    });

    it("drops inherited Claude --permission-mode extraArgs and their values", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
        extraArgs: ["--permission-mode", "bypassPermissions", "--model", "gpt-5.2"],
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).not.toContain("--permission-mode");
      expect(argv).not.toContain("bypassPermissions");
      expect(argv).toContain("--model");
      expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5.2");
      expect(argv).toContain('sandbox_mode="danger-full-access"');
      expect(argv).toContain('approval_policy="never"');
    });

    it("drops inherited Claude --permission-mode=value extraArgs", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
        extraArgs: ["--permission-mode=bypassPermissions"],
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).not.toContain("--permission-mode=bypassPermissions");
      expect(argv).toContain('sandbox_mode="danger-full-access"');
      expect(argv).toContain('approval_policy="never"');
    });
  });
});
