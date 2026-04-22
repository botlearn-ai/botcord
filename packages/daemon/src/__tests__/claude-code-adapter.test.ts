import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";

// The adapter spawns whatever binary we point it at; we point it at a small
// Node script so we control stdout/stderr/exit precisely without needing the
// real `claude` CLI.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "daemon-claude-"));

function makeScript(name: string, body: string): string {
  const p = path.join(tmpRoot, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runAdapter(script: string) {
  const adapter = new ClaudeCodeAdapter({ binary: script });
  const ctrl = new AbortController();
  return adapter.run({
    text: "hi",
    sessionId: null,
    cwd: tmpRoot,
    signal: ctrl.signal,
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
      cwd: tmpRoot,
      signal: ctrl.signal,
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
});
