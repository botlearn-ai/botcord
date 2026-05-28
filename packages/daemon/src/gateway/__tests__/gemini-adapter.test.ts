import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiAdapter } from "../runtimes/gemini.js";
import { geminiModule } from "../runtimes/registry.js";

// The adapter spawns whatever binary we point it at; we point it at a small
// Node script so we control stdout/stderr/exit precisely without needing the
// real `gemini` CLI.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-gemini-"));

const originalHome = process.env.HOME;
const agentHomeRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-gemini-home-"));

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

function runAdapter(
  script: string,
  opts: {
    sessionId?: string | null;
    systemContext?: string;
    extraArgs?: string[];
    onBlock?: (kind: string) => void;
    onStatus?: (e: { phase: string; label?: string }) => void;
  } = {},
) {
  const adapter = new GeminiAdapter({ binary: script });
  const ctrl = new AbortController();
  return adapter.run({
    text: "hi",
    sessionId: opts.sessionId ?? null,
    accountId: "ag_test",
    cwd: tmpRoot,
    signal: ctrl.signal,
    trustLevel: "owner",
    systemContext: opts.systemContext,
    extraArgs: opts.extraArgs,
    onBlock: opts.onBlock ? (b) => opts.onBlock!(b.kind) : undefined,
    onStatus: opts.onStatus
      ? (e) => {
          if (e.kind === "thinking") opts.onStatus!({ phase: e.phase, label: e.label });
        }
      : undefined,
  });
}

describe("GeminiAdapter", () => {
  it("captures session_id from init and concatenates assistant deltas as final text", async () => {
    const script = makeScript(
      "happy.js",
      `
const lines = [
  {type:"init", timestamp:"t0", session_id:"abc-123-session", model:"gemini-2.5-pro"},
  {type:"message", timestamp:"t1", role:"user", content:"hi"},
  {type:"message", timestamp:"t2", role:"assistant", content:"hello ", delta:true},
  {type:"message", timestamp:"t3", role:"assistant", content:"from gemini", delta:true},
  {type:"result", timestamp:"t4", status:"success", stats:{}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
process.exit(0);
`,
    );
    const res = await runAdapter(script);
    expect(res.newSessionId).toBe("abc-123-session");
    expect(res.text).toBe("hello from gemini");
    expect(res.error).toBeUndefined();
  });

  it("emits StreamBlocks for assistant_text / tool_use / tool_result / system kinds", async () => {
    const script = makeScript(
      "blocks.js",
      `
const lines = [
  {type:"init", timestamp:"t0", session_id:"sess1", model:"gemini-2.5-pro"},
  {type:"tool_use", timestamp:"t1", tool_name:"read_file", tool_id:"t_0", parameters:{path:"x"}},
  {type:"tool_result", timestamp:"t2", tool_id:"t_0", status:"success", output:"ok"},
  {type:"message", timestamp:"t3", role:"assistant", content:"done", delta:true},
  {type:"result", timestamp:"t4", status:"success", stats:{}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const seen: string[] = [];
    const res = await runAdapter(script, { onBlock: (k) => seen.push(k) });
    expect(res.text).toBe("done");
    expect(seen).toContain("system"); // init + result
    expect(seen).toContain("tool_use");
    expect(seen).toContain("tool_result");
    expect(seen).toContain("assistant_text");
  });

  it("emits thinking onStatus events for init, tool_use, assistant message, and result", async () => {
    const script = makeScript(
      "thinkflow.js",
      `
const lines = [
  {type:"init", timestamp:"t0", session_id:"sess2"},
  {type:"tool_use", timestamp:"t1", tool_name:"shell", tool_id:"t_0", parameters:{}},
  {type:"tool_result", timestamp:"t2", tool_id:"t_0", status:"success"},
  {type:"message", timestamp:"t3", role:"assistant", content:"ok", delta:true},
  {type:"result", timestamp:"t4", status:"success", stats:{}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const status: Array<{ phase: string; label?: string }> = [];
    await runAdapter(script, { onStatus: (e) => status.push(e) });
    expect(status).toEqual([
      { phase: "started", label: "Starting session" },
      { phase: "updated", label: "shell" },
      { phase: "stopped", label: undefined },
      { phase: "stopped", label: undefined },
    ]);
  });

  it("no sessionId → spawn without --resume", async () => {
    const script = makeScript(
      "fresh-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"init", session_id:"new-sess"}) + "\\n");
process.stdout.write(JSON.stringify({type:"message", role:"assistant", content:JSON.stringify(argv), delta:true}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", status:"success", stats:{}}) + "\\n");
`,
    );
    const res = await runAdapter(script, { sessionId: null });
    const argv = JSON.parse(res.text) as string[];
    expect(argv).not.toContain("--resume");
    expect(argv).toContain("-p");
    expect(argv).toContain("hi");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--yolo");
    expect(argv).toContain("--skip-trust");
  });

  it("with sessionId → spawn with `--resume <id>`", async () => {
    const script = makeScript(
      "resume-argv.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"init", session_id:"continued"}) + "\\n");
process.stdout.write(JSON.stringify({type:"message", role:"assistant", content:JSON.stringify(argv), delta:true}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", status:"success", stats:{}}) + "\\n");
`,
    );
    const sid = "abc-123-session";
    const res = await runAdapter(script, { sessionId: sid });
    const argv = JSON.parse(res.text) as string[];
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(sid);
  });

  it("rejects invalid sessionId before spawn", async () => {
    const script = makeScript("noop.js", "process.exit(0);");
    const adapter = new GeminiAdapter({ binary: script });
    const ctrl = new AbortController();
    await expect(
      adapter.run({
        text: "x",
        sessionId: "../bad space",
        accountId: "ag_test",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "owner",
      }),
    ).rejects.toThrow(/invalid sessionId/);
  });

  it("prepends systemContext to the positional prompt", async () => {
    const script = makeScript(
      "echo-prompt.js",
      `
const argv = process.argv.slice(2);
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? argv[pIdx + 1] : "";
process.stdout.write(JSON.stringify({type:"init", session_id:"s1"}) + "\\n");
process.stdout.write(JSON.stringify({type:"message", role:"assistant", content:prompt, delta:true}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", status:"success", stats:{}}) + "\\n");
`,
    );
    const res = await runAdapter(script, {
      systemContext: "MEMORY: remember X\nDIGEST: room Y was active",
    });
    expect(res.text).toContain("MEMORY: remember X");
    expect(res.text).toContain("DIGEST: room Y was active");
    expect(res.text).toContain("---");
    expect(res.text.endsWith("hi")).toBe(true);
  });

  it("empty systemContext leaves the prompt unchanged", async () => {
    const script = makeScript(
      "echo-prompt-empty.js",
      `
const argv = process.argv.slice(2);
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? argv[pIdx + 1] : "";
process.stdout.write(JSON.stringify({type:"init", session_id:"s2"}) + "\\n");
process.stdout.write(JSON.stringify({type:"message", role:"assistant", content:prompt, delta:true}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", status:"success", stats:{}}) + "\\n");
`,
    );
    const res = await runAdapter(script, { systemContext: "   \n\n  " });
    expect(res.text).toBe("hi");
  });

  it("does not double-add --yolo when extraArgs already supplies --approval-mode", async () => {
    const script = makeScript(
      "echo-yolo.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"init", session_id:"s3"}) + "\\n");
process.stdout.write(JSON.stringify({type:"message", role:"assistant", content:JSON.stringify(argv), delta:true}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", status:"success", stats:{}}) + "\\n");
`,
    );
    const res = await runAdapter(script, {
      extraArgs: ["--approval-mode", "plan"],
    });
    const argv = JSON.parse(res.text) as string[];
    expect(argv).toContain("--approval-mode");
    expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("plan");
    expect(argv).not.toContain("--yolo");
  });

  it("strips claude-code / codex foreign flags from extraArgs", async () => {
    const script = makeScript(
      "echo-strip.js",
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({type:"init", session_id:"s4"}) + "\\n");
process.stdout.write(JSON.stringify({type:"message", role:"assistant", content:JSON.stringify(argv), delta:true}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", status:"success", stats:{}}) + "\\n");
`,
    );
    const res = await runAdapter(script, {
      extraArgs: [
        "--append-system-prompt",
        "ignored content",
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources=project",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "gemini-2.5-pro",
      ],
    });
    const argv = JSON.parse(res.text) as string[];
    // Foreign flags + their values are dropped …
    expect(argv).not.toContain("--append-system-prompt");
    expect(argv).not.toContain("ignored content");
    expect(argv).not.toContain("--permission-mode");
    expect(argv).not.toContain("bypassPermissions");
    expect(argv).not.toContain("--setting-sources=project");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    // … but gemini-native flags survive.
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-2.5-pro");
  });

  it("surfaces result.status=error as the run error and wipes session id", async () => {
    const script = makeScript(
      "failed.js",
      `
const lines = [
  {type:"init", timestamp:"t0", session_id:"will-be-wiped"},
  {type:"message", timestamp:"t1", role:"assistant", content:"partial", delta:true},
  {type:"result", timestamp:"t2", status:"error", error:{type:"AUTH", message:"please run gemini auth login"}, stats:{}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
process.exit(1);
`,
    );
    const res = await runAdapter(script);
    expect(res.error).toMatch(/gemini auth login/);
    expect(res.newSessionId).toBe("");
    expect(res.text).toBe("");
  });

  it("surfaces non-zero exit + stderr when no result event is emitted", async () => {
    const script = makeScript(
      "boom.js",
      `
process.stderr.write("FATAL: gemini setup incomplete\\n");
process.exit(7);
`,
    );
    const res = await runAdapter(script);
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/code 7/);
    expect(res.error).toMatch(/setup incomplete/);
  });

  it("non-fatal `error` events with severity=warning do not override assistant text", async () => {
    const script = makeScript(
      "warning.js",
      `
const lines = [
  {type:"init", timestamp:"t0", session_id:"sess-warn"},
  {type:"error", timestamp:"t1", severity:"warning", message:"loop detected, retrying"},
  {type:"message", timestamp:"t2", role:"assistant", content:"final answer", delta:true},
  {type:"result", timestamp:"t3", status:"success", stats:{}},
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
    );
    const res = await runAdapter(script);
    expect(res.text).toBe("final answer");
    expect(res.error).toBeUndefined();
  });

  it("returns early when signal is already aborted", async () => {
    const script = makeScript("noop.js", "process.exit(0);");
    const adapter = new GeminiAdapter({ binary: script });
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
});

describe("geminiModule registration", () => {
  it("declares supportsRun (via default) so the dispatcher routes turns to it", () => {
    // The registry treats `supportsRun === undefined` as true. We assert
    // the field isn't set to `false` so a regression on registry.ts shows
    // up here rather than as a confusing runtime "probe-only stub" error.
    expect(geminiModule.supportsRun).not.toBe(false);
    expect(geminiModule.id).toBe("gemini");
    expect(geminiModule.envVar).toBe("BOTCORD_GEMINI_BIN");
    expect(geminiModule.installHint).toBeDefined();
  });
});
