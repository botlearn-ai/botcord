import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KimiAdapter } from "../runtimes/kimi.js";
import { createRuntime, envVarForRuntime, listRuntimeIds } from "../runtimes/registry.js";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-kimi-"));

function makeScript(name: string, body: string): string {
  const p = path.join(tmpRoot, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runAdapter(script: string, sessionId: string | null = null, extraArgs?: string[]) {
  const adapter = new KimiAdapter({ binary: script });
  const ctrl = new AbortController();
  return adapter.run({
    text: "hi",
    sessionId,
    accountId: "ag_test",
    cwd: tmpRoot,
    signal: ctrl.signal,
    trustLevel: "owner",
    extraArgs,
  });
}

describe("KimiAdapter", () => {
  it("is registered as a runnable runtime", () => {
    expect(listRuntimeIds()).toContain("kimi-cli");
    expect(envVarForRuntime("kimi-cli")).toBe("BOTCORD_KIMI_CLI_BIN");
    expect(createRuntime("kimi-cli")).toBeInstanceOf(KimiAdapter);
  });

  it("parses final assistant text and persists the generated --session id", async () => {
    const script = makeScript(
      "happy.js",
      `
process.stdout.write(JSON.stringify({role:"assistant", content:"hello from kimi"}) + "\\n");
`,
    );
    const res = await runAdapter(script);
    expect(res.newSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.text).toBe("hello from kimi");
    expect(res.error).toBeUndefined();
  });

  it("passes an existing session id through --session", async () => {
    const script = makeScript(
      "resume-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({role:"assistant", content:JSON.stringify(argv)}) + "\\n");
`,
    );
    const res = await runAdapter(script, "sid-123");
    const argv = JSON.parse(res.text) as string[];
    const idx = argv.indexOf("--session");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("sid-123");
    expect(argv).toContain("--print");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--afk");
  });

  it("drops non-Kimi inherited extraArgs and their values", async () => {
    const script = makeScript(
      "filter-foreign-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({role:"assistant", content:JSON.stringify(argv)}) + "\\n");
`,
    );
    const res = await runAdapter(script, "sid-123", [
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "kimi-k2",
    ]);
    const argv = JSON.parse(res.text) as string[];
    expect(argv).not.toContain("--permission-mode");
    expect(argv).not.toContain("bypassPermissions");
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("kimi-k2");
  });

  it("preserves Kimi value flags with negative numeric values", async () => {
    const script = makeScript(
      "negative-value-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({role:"assistant", content:JSON.stringify(argv)}) + "\\n");
`,
    );
    const res = await runAdapter(script, "sid-123", [
      "--max-ralph-iterations",
      "-1",
      "--max-steps-per-turn=3",
    ]);
    const argv = JSON.parse(res.text) as string[];
    expect(argv).toContain("--max-ralph-iterations");
    expect(argv[argv.indexOf("--max-ralph-iterations") + 1]).toBe("-1");
    expect(argv).toContain("--max-steps-per-turn=3");
  });

  it("drops incomplete Kimi value flags instead of passing invalid argv", async () => {
    const script = makeScript(
      "incomplete-value-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({role:"assistant", content:JSON.stringify(argv)}) + "\\n");
`,
    );
    const res = await runAdapter(script, "sid-123", ["--model", "--plan"]);
    const argv = JSON.parse(res.text) as string[];
    expect(argv).not.toContain("--model");
    expect(argv).toContain("--plan");
  });

  it("does not let extraArgs override adapter-owned stream/session/prompt flags", async () => {
    const script = makeScript(
      "filter-owned-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({role:"assistant", content:JSON.stringify(argv)}) + "\\n");
`,
    );
    const res = await runAdapter(script, "real-session", [
      "--output-format",
      "text",
      "--session",
      "evil-session",
      "--prompt",
      "evil prompt",
      "--plan",
    ]);
    const argv = JSON.parse(res.text) as string[];
    expect(argv.filter((a) => a === "--output-format")).toHaveLength(1);
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv.filter((a) => a === "--session")).toHaveLength(1);
    expect(argv[argv.indexOf("--session") + 1]).toBe("real-session");
    expect(argv.filter((a) => a === "--prompt")).toHaveLength(1);
    expect(argv[argv.indexOf("--prompt") + 1]).toBe("hi");
    expect(argv).toContain("--plan");
    expect(argv).not.toContain("evil-session");
    expect(argv).not.toContain("evil prompt");
  });

  it("rejects session ids that could be parsed as flags", async () => {
    const script = makeScript(
      "should-not-spawn.js",
      `
process.stdout.write(JSON.stringify({role:"assistant", content:"spawned"}) + "\\n");
`,
    );
    const res = await runAdapter(script, "--bad");
    expect(res.newSessionId).toBe("");
    expect(res.text).toBe("");
    expect(res.error).toMatch(/invalid sessionId/);
  });

  it("prefixes systemContext as a system-reminder in the prompt", async () => {
    const script = makeScript(
      "echo-prompt.js",
      `
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("--prompt") + 1];
process.stdout.write(JSON.stringify({role:"assistant", content:prompt}) + "\\n");
`,
    );
    const adapter = new KimiAdapter({ binary: script });
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
    expect(res.text).toContain("<system-reminder>");
    expect(res.text).toContain("MEMORY: remember X");
    expect(res.text).toContain("do the thing");
  });

  it("recognizes tool_use and tool_result blocks", async () => {
    const script = makeScript(
      "tools.js",
      `
const lines = [
  {role:"assistant", content:null, tool_calls:[{id:"tc1", function:{name:"Bash", arguments:"{}"}}]},
  {role:"tool", tool_call_id:"tc1", content:"ok"},
  {role:"assistant", content:[{type:"text", text:"done"}]},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const adapter = new KimiAdapter({ binary: script });
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
    expect(seen).toContain("tool_result");
    expect(seen).toContain("assistant_text");
  });

  it("emits thinking status for think, tool call, tool result, and final text", async () => {
    const script = makeScript(
      "thinkflow.js",
      `
const lines = [
  {role:"assistant", content:[{type:"think", think:"working"}]},
  {role:"assistant", content:null, tool_calls:[{id:"tc1", function:{name:"ReadFile", arguments:"{}"}}]},
  {role:"tool", tool_call_id:"tc1", content:"ok"},
  {role:"assistant", content:"done"},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const adapter = new KimiAdapter({ binary: script });
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
        if (e.kind === "thinking") status.push({ phase: e.phase, label: e.label });
      },
    });
    expect(status).toEqual([
      { phase: "started", label: "Thinking" },
      { phase: "updated", label: "ReadFile" },
      { phase: "updated", label: "Tool result" },
      { phase: "stopped", label: undefined },
    ]);
  });
});
