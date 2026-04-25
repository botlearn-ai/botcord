import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../runtimes/claude-code.js";

// The adapter spawns whatever binary we point it at; we point it at a small
// Node script so we control stdout/stderr/exit precisely without needing the
// real `claude` CLI.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-claude-"));

function makeScript(name: string, body: string): string {
  const p = path.join(tmpRoot, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runAdapter(script: string, sessionId: string | null = null) {
  const adapter = new ClaudeCodeAdapter({ binary: script });
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

describe("ClaudeCodeAdapter", () => {
  it("parses session_id from system init + concatenates assistant text", async () => {
    const script = makeScript(
      "happy.js",
      `
const lines = [
  {type:"system", subtype:"init", session_id:"sid-123"},
  {type:"assistant", message:{content:[{type:"text", text:"hello "},{type:"text", text:"world"}]}},
  {type:"result", subtype:"success", session_id:"sid-123", total_cost_usd:0.0042, result:"hello world"},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
process.exit(0);
`,
    );
    const res = await runAdapter(script);
    expect(res.newSessionId).toBe("sid-123");
    expect(res.text).toBe("hello world");
    expect(res.costUsd).toBeCloseTo(0.0042);
    expect(res.error).toBeUndefined();
  });

  it("recognizes tool_use block via onBlock callback", async () => {
    const script = makeScript(
      "tooluse.js",
      `
const lines = [
  {type:"system", subtype:"init", session_id:"sid-2"},
  {type:"assistant", message:{content:[{type:"tool_use", id:"tu1", name:"Bash", input:{}}]}},
  {type:"assistant", message:{content:[{type:"text", text:"done"}]}},
  {type:"result", subtype:"success", session_id:"sid-2", result:"done"},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const adapter = new ClaudeCodeAdapter({ binary: script });
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

  it("skips non-JSON stdout lines and still returns result", async () => {
    const script = makeScript(
      "nonjson.js",
      `
process.stdout.write("this is not json\\n");
process.stdout.write(JSON.stringify({type:"system", subtype:"init", session_id:"sid-3"}) + "\\n");
process.stdout.write("   \\n"); // blank line ignored
process.stdout.write(JSON.stringify({type:"result", subtype:"success", session_id:"sid-3", result:"ok"}) + "\\n");
`,
    );
    const res = await runAdapter(script);
    expect(res.newSessionId).toBe("sid-3");
    expect(res.text).toBe("ok");
    expect(res.error).toBeUndefined();
  });

  it("surfaces error from non-zero exit + stderr", async () => {
    const script = makeScript(
      "boom.js",
      `
process.stderr.write("claude: auth failure\\n");
process.exit(2);
`,
    );
    const res = await runAdapter(script);
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/code 2/);
    expect(res.error).toMatch(/auth failure/);
  });

  it("wipes newSessionId on non-success result so dispatcher can drop the stale entry", async () => {
    // Mirrors what Claude Code emits when `--resume <missing-uuid>` is used:
    // a fresh `session_id` for the just-spawned empty session, plus a non-success
    // result subtype. Persisting that new id would trap us into re-resuming a
    // useless UUID every turn.
    const script = makeScript(
      "resume-miss.js",
      `
process.stderr.write("No conversation found\\n");
process.stdout.write(JSON.stringify({
  type:"result",
  subtype:"error_during_execution",
  session_id:"sid-useless",
  is_error:true,
  errors:["No conversation found with session ID: 00000000-0000-0000-0000-000000000000"]
}) + "\\n");
process.exit(1);
`,
    );
    const res = await runAdapter(script);
    expect(res.newSessionId).toBe("");
    expect(res.error).toBeDefined();
  });

  it("picks up result.result even if assistant text is empty", async () => {
    const script = makeScript(
      "resultonly.js",
      `
process.stdout.write(JSON.stringify({type:"system", subtype:"init", session_id:"sid-4"}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", subtype:"success", session_id:"sid-4", total_cost_usd:0.01, result:"final-only"}) + "\\n");
`,
    );
    const res = await runAdapter(script);
    expect(res.text).toBe("final-only");
    expect(res.costUsd).toBe(0.01);
    expect(res.newSessionId).toBe("sid-4");
  });

  it("returns a deletion signal for session ids that could be parsed as flags", async () => {
    const script = makeScript(
      "should-not-spawn.js",
      `
process.stdout.write(JSON.stringify({type:"result", subtype:"success", result:"spawned"}) + "\\n");
`,
    );
    const res = await runAdapter(script, "--bad");
    expect(res.newSessionId).toBe("");
    expect(res.error).toMatch(/invalid sessionId/);
    expect(res.text).toBe("");
  });

  it("passes a valid session id through --resume", async () => {
    const script = makeScript(
      "resume-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"system", subtype:"init", session_id:"sid-next"}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", subtype:"success", session_id:"sid-next", result: JSON.stringify(argv)}) + "\\n");
`,
    );
    const res = await runAdapter(script, "00000000-0000-4000-8000-000000000000");
    const argv = JSON.parse(res.text) as string[];
    const idx = argv.indexOf("--resume");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("allows non-ASCII historical session titles through --resume", async () => {
    const script = makeScript(
      "resume-title-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"system", subtype:"init", session_id:"sid-next"}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", subtype:"success", session_id:"sid-next", result: JSON.stringify(argv)}) + "\\n");
`,
    );
    const res = await runAdapter(script, "会话标题");
    const argv = JSON.parse(res.text) as string[];
    const idx = argv.indexOf("--resume");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("会话标题");
  });

  describe("trustLevel → --permission-mode", () => {
    // The adapter's argv is not directly inspectable, so we have the spawned
    // script echo its own argv back through a JSON event and assert on it.
    const echoScript = () =>
      makeScript(
        "echo-argv.js",
        `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"system", subtype:"init", session_id:"sid-echo"}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", subtype:"success", session_id:"sid-echo", result: JSON.stringify(argv)}) + "\\n");
`,
      );

    it("owner → --permission-mode bypassPermissions", async () => {
      const adapter = new ClaudeCodeAdapter({ binary: echoScript() });
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
      const modeIdx = argv.indexOf("--permission-mode");
      expect(modeIdx).toBeGreaterThanOrEqual(0);
      expect(argv[modeIdx + 1]).toBe("bypassPermissions");
    });

    it("public → --permission-mode default", async () => {
      const adapter = new ClaudeCodeAdapter({ binary: echoScript() });
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
      const modeIdx = argv.indexOf("--permission-mode");
      expect(modeIdx).toBeGreaterThanOrEqual(0);
      expect(argv[modeIdx + 1]).toBe("default");
    });

    it("trusted → --permission-mode default", async () => {
      const adapter = new ClaudeCodeAdapter({ binary: echoScript() });
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
      const modeIdx = argv.indexOf("--permission-mode");
      expect(modeIdx).toBeGreaterThanOrEqual(0);
      expect(argv[modeIdx + 1]).toBe("default");
    });

    it("systemContext → --append-system-prompt <text>", async () => {
      const adapter = new ClaudeCodeAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "owner",
        systemContext: "MEMORY=remember_this",
      });
      const argv = JSON.parse(res.text) as string[];
      const idx = argv.indexOf("--append-system-prompt");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(argv[idx + 1]).toBe("MEMORY=remember_this");
    });

    it("omits --append-system-prompt when systemContext is undefined", async () => {
      const adapter = new ClaudeCodeAdapter({ binary: echoScript() });
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
      expect(argv).not.toContain("--append-system-prompt");
    });

    it("extraArgs --permission-mode overrides trustLevel", async () => {
      const adapter = new ClaudeCodeAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
        extraArgs: ["--permission-mode", "plan"],
      });
      const argv = JSON.parse(res.text) as string[];
      // Only one --permission-mode should appear (the override).
      const modes = argv.filter((a) => a === "--permission-mode");
      expect(modes.length).toBe(1);
      const modeIdx = argv.indexOf("--permission-mode");
      expect(argv[modeIdx + 1]).toBe("plan");
    });
  });
});
