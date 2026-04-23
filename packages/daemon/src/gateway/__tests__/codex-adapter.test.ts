import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../runtimes/codex.js";

// The adapter spawns whatever binary we point it at; we point it at a small
// Node script so we control stdout/stderr/exit precisely without needing the
// real `codex` CLI.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-codex-"));

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
  const adapter = new CodexAdapter({ binary: script });
  const ctrl = new AbortController();
  return adapter.run({
    text: "hi",
    sessionId,
    cwd: tmpRoot,
    signal: ctrl.signal,
    trustLevel: "owner",
  });
}

describe("CodexAdapter", () => {
  it("parses final agent_message text (newSessionId intentionally empty — resume disabled)", async () => {
    const script = makeScript(
      "happy.js",
      `
const lines = [
  {type:"thread.started", thread_id:"tid-123"},
  {type:"turn.started"},
  {type:"item.completed", item:{id:"i0", type:"agent_message", text:"hello from codex"}},
  {type:"turn.completed", usage:{input_tokens:1, output_tokens:2}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
process.exit(0);
`,
    );
    const res = await runAdapter(script);
    // See adapter class doc: Codex always spawns fresh — thread_id is observed
    // but NOT persisted, so the dispatcher's SessionStore stays empty.
    expect(res.newSessionId).toBe("");
    expect(res.text).toBe("hello from codex");
    expect(res.error).toBeUndefined();
  });

  it("emits tool_use StreamBlock for command_execution items", async () => {
    const script = makeScript(
      "toolblock.js",
      `
const lines = [
  {type:"thread.started", thread_id:"tid-2"},
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

  it("ignores sessionId and always spawns fresh `codex exec` (no resume subcommand)", async () => {
    const script = makeScript(
      "resume.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"tid-fresh"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"i0", type:"agent_message", text:JSON.stringify(argv)}}) + "\\n");
`,
    );
    const uuid = "01234567-89ab-7def-8123-456789abcdef";
    const res = await runAdapter(script, uuid);
    const argv = JSON.parse(res.text) as string[];
    expect(argv[0]).toBe("exec");
    expect(argv).not.toContain("resume");
    expect(argv).not.toContain(uuid);
    expect(res.newSessionId).toBe("");
  });

  it("rejects non-UUID sessionId before spawn", async () => {
    const script = makeScript("noop.js", "process.exit(0);");
    const adapter = new CodexAdapter({ binary: script });
    const ctrl = new AbortController();
    await expect(
      adapter.run({
        text: "x",
        sessionId: "--not-a-uuid",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "owner",
      }),
    ).rejects.toThrow(/invalid sessionId/);
  });

  it("returns early when signal is already aborted", async () => {
    const script = makeScript("noop.js", "process.exit(0);");
    const adapter = new CodexAdapter({ binary: script });
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await adapter.run({
      text: "x",
      sessionId: null,
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
  {type:"thread.started", thread_id:"tid-3"},
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

  describe("trustLevel → sandbox defaults", () => {
    // Echo argv back via the same `thread.started` / `agent_message` shape
    // so we can assert on the flags the adapter chose.
    const echoScript = () =>
      makeScript(
        "echo-argv.js",
        `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"tid-echo"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"i0", type:"agent_message", text: JSON.stringify(argv)}}) + "\\n");
`,
      );

    it("owner → --dangerously-bypass-approvals-and-sandbox", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "owner",
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain("-s");
    });

    it("public → `-s workspace-write`, no bypass", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      const sIdx = argv.indexOf("-s");
      expect(sIdx).toBeGreaterThanOrEqual(0);
      expect(argv[sIdx + 1]).toBe("workspace-write");
    });

    it("trusted → `-s workspace-write`, no bypass", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "trusted",
      });
      const argv = JSON.parse(res.text) as string[];
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      const sIdx = argv.indexOf("-s");
      expect(sIdx).toBeGreaterThanOrEqual(0);
      expect(argv[sIdx + 1]).toBe("workspace-write");
    });

    it("systemContext is prepended to the positional prompt (new session each turn — safe)", async () => {
      const script = makeScript(
        "echo-prompt.js",
        `
const argv = process.argv.slice(2);
const dashIdx = argv.indexOf("--");
const prompt = dashIdx >= 0 ? argv.slice(dashIdx + 1).join(" ") : "";
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"tid-x"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"i0", type:"agent_message", text: prompt}}) + "\\n");
`,
      );
      const adapter = new CodexAdapter({ binary: script });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "do the thing",
        sessionId: null,
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "owner",
        systemContext: "MEMORY: remember X",
      });
      expect(res.text).toContain("MEMORY: remember X");
      expect(res.text).toContain("do the thing");
      expect(res.text).toContain("---");
    });

    it("extraArgs `-s read-only` overrides the public default", async () => {
      const adapter = new CodexAdapter({ binary: echoScript() });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "x",
        sessionId: null,
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "public",
        extraArgs: ["-s", "read-only"],
      });
      const argv = JSON.parse(res.text) as string[];
      // Only one `-s` appears — the one we passed.
      expect(argv.filter((a) => a === "-s").length).toBe(1);
      expect(argv[argv.indexOf("-s") + 1]).toBe("read-only");
    });
  });
});
