import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HermesAgentAdapter,
  hermesProfileHomeDir,
  listHermesProfiles,
  resolveHermesAcpCommand,
} from "../runtimes/hermes-agent.js";
import { agentHermesWorkspaceDir } from "../../agent-workspace.js";

// Spawn a tiny Node "ACP server" we control instead of the real hermes-acp.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-hermes-"));

const originalHome = process.env.HOME;
const agentHomeRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-hermes-home-"));

beforeAll(() => {
  process.env.HOME = agentHomeRoot;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(agentHomeRoot, { recursive: true, force: true });
});

/**
 * Mock ACP server. Reads newline-delimited JSON-RPC messages from stdin
 * and replies on stdout. The script body controls the per-test scenario.
 */
function makeAcpServer(name: string, script: string): string {
  const body = `
const lines = [];
let buf = "";
process.stdin.setEncoding("utf8");
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function reply(req, result) { send({ jsonrpc: "2.0", id: req.id, result }); }
function err(req, code, message) { send({ jsonrpc: "2.0", id: req.id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
let nextReqId = 1000;
const pending = new Map();
function request(method, params) {
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
async function handle(msg) {
${script}
}
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    // Server received a response to a request it sent
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      continue;
    }
    try { await handle(msg); } catch (e) { process.stderr.write("mock error: " + e + "\\n"); }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
  const p = path.join(tmpRoot, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

interface RunOpts {
  sessionId?: string | null;
  trustLevel?: "owner" | "trusted" | "public";
  systemContext?: string;
  accountId?: string;
  onBlock?: (b: unknown) => void;
  onStatus?: (e: unknown) => void;
}

function runAdapter(script: string, opts: RunOpts = {}) {
  const adapter = new HermesAgentAdapter({ binary: script });
  const ctrl = new AbortController();
  return adapter.run({
    text: "hello",
    sessionId: opts.sessionId ?? null,
    accountId: opts.accountId ?? "ag_hermes_test",
    cwd: tmpRoot,
    signal: ctrl.signal,
    trustLevel: opts.trustLevel ?? "owner",
    systemContext: opts.systemContext,
    onBlock: opts.onBlock as never,
    onStatus: opts.onStatus as never,
  });
}

describe("HermesAgentAdapter", () => {
  it("happy path: initialize → session/new → session/prompt with streamed text", async () => {
    const script = makeAcpServer(
      "happy.js",
      `
        if (msg.method === "initialize") {
          reply(msg, { protocolVersion: 1, agentInfo: { name: "mock", version: "0.0.1" }, agentCapabilities: {} });
        } else if (msg.method === "session/new") {
          reply(msg, { sessionId: "sess-001" });
        } else if (msg.method === "session/prompt") {
          notify("session/update", { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi " } } });
          notify("session/update", { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } });
          reply(msg, { stopReason: "end_turn" });
          process.stdin.pause();
          process.exit(0);
        }
      `,
    );
    const blocks: any[] = [];
    const res = await runAdapter(script, { onBlock: (b) => blocks.push(b) });
    expect(res.error).toBeUndefined();
    expect(res.newSessionId).toBe("sess-001");
    expect(res.text).toBe("hi world");
    expect(blocks.map((b) => b.kind)).toContain("assistant_text");
  });

  it("session/load success → reuses incoming sessionId", async () => {
    const script = makeAcpServer(
      "load.js",
      `
        if (msg.method === "initialize") {
          reply(msg, { protocolVersion: 1 });
        } else if (msg.method === "session/load") {
          // Hermes returns null/empty body without sessionId — adapter must
          // reuse opts.sessionId.
          reply(msg, {});
        } else if (msg.method === "session/new") {
          reply(msg, { sessionId: "should-not-be-used" });
        } else if (msg.method === "session/prompt") {
          notify("session/update", { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "resumed" } } });
          reply(msg, { stopReason: "end_turn" });
          process.exit(0);
        }
      `,
    );
    const res = await runAdapter(script, { sessionId: "sess-existing" });
    expect(res.newSessionId).toBe("sess-existing");
    expect(res.text).toBe("resumed");
  });

  it("session/load failure → falls back to session/new", async () => {
    const script = makeAcpServer(
      "load-miss.js",
      `
        if (msg.method === "initialize") {
          reply(msg, { protocolVersion: 1 });
        } else if (msg.method === "session/load") {
          err(msg, -32000, "not found");
        } else if (msg.method === "session/new") {
          reply(msg, { sessionId: "sess-fresh" });
        } else if (msg.method === "session/prompt") {
          reply(msg, { stopReason: "end_turn" });
          process.exit(0);
        }
      `,
    );
    const res = await runAdapter(script, { sessionId: "sess-stale" });
    expect(res.newSessionId).toBe("sess-fresh");
    expect(res.error).toBeUndefined();
  });

  it("owner trust → request_permission selects an allow_* option", async () => {
    const script = makeAcpServer(
      "perm-allow.js",
      `
        if (msg.method === "initialize") {
          reply(msg, { protocolVersion: 1 });
        } else if (msg.method === "session/new") {
          reply(msg, { sessionId: "sess-perm" });
        } else if (msg.method === "session/prompt") {
          const outcome = await request("session/request_permission", {
            sessionId: msg.params.sessionId,
            toolCall: { name: "shell", rawInput: { cmd: "ls" } },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" }
            ]
          });
          notify("session/update", { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "outcome=" + JSON.stringify(outcome) } } });
          reply(msg, { stopReason: "end_turn" });
          process.exit(0);
        }
      `,
    );
    const res = await runAdapter(script, { trustLevel: "owner" });
    expect(res.text).toContain('"outcome":"selected"');
    expect(res.text).toContain('"optionId":"allow"');
  });

  it("public trust → request_permission cancels", async () => {
    const script = makeAcpServer(
      "perm-deny.js",
      `
        if (msg.method === "initialize") {
          reply(msg, { protocolVersion: 1 });
        } else if (msg.method === "session/new") {
          reply(msg, { sessionId: "sess-perm" });
        } else if (msg.method === "session/prompt") {
          const outcome = await request("session/request_permission", {
            sessionId: msg.params.sessionId,
            options: [
              { optionId: "allow", kind: "allow_once" },
              { optionId: "deny", kind: "reject_once" }
            ]
          });
          notify("session/update", { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(outcome) } } });
          reply(msg, { stopReason: "end_turn" });
          process.exit(0);
        }
      `,
    );
    const res = await runAdapter(script, { trustLevel: "public" });
    expect(res.text).toContain('"outcome":"cancelled"');
    expect(res.text).not.toContain("optionId");
  });

  it("writes systemContext to <hermes-workspace>/AGENTS.md before spawn", async () => {
    const script = makeAcpServer(
      "ctx.js",
      `
        if (msg.method === "initialize") { reply(msg, { protocolVersion: 1 }); }
        else if (msg.method === "session/new") { reply(msg, { sessionId: "sess-ctx" }); }
        else if (msg.method === "session/prompt") { reply(msg, { stopReason: "end_turn" }); process.exit(0); }
      `,
    );
    await runAdapter(script, {
      accountId: "ag_ctx_test",
      systemContext: "MEMORY: remember X\nDIGEST: room Y",
    });
    const ws = agentHermesWorkspaceDir("ag_ctx_test");
    const agentsMd = path.join(ws, "AGENTS.md");
    expect(existsSync(agentsMd)).toBe(true);
    const body = readFileSync(agentsMd, "utf8");
    expect(body).toContain("MEMORY: remember X");
    expect(body).toContain("DIGEST: room Y");
  });

  it("session/new uses hermes-workspace as cwd, not the route cwd", async () => {
    const script = makeAcpServer(
      "cwd-echo.js",
      `
        if (msg.method === "initialize") { reply(msg, { protocolVersion: 1 }); }
        else if (msg.method === "session/new") {
          reply(msg, { sessionId: "sess-cwd" });
          // Echo back the cwd we received via a streamed update on prompt.
          this.__cwd = msg.params && msg.params.cwd;
        } else if (msg.method === "session/prompt") {
          notify("session/update", { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: this.__cwd || "" } } });
          reply(msg, { stopReason: "end_turn" });
          process.exit(0);
        }
      `,
    );
    const res = await runAdapter(script, { accountId: "ag_cwd_test" });
    expect(res.text).toBe(agentHermesWorkspaceDir("ag_cwd_test"));
  });

  it("returns early when signal is already aborted", async () => {
    const script = makeAcpServer("noop.js", "");
    const adapter = new HermesAgentAdapter({ binary: script });
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await adapter.run({
      text: "x",
      sessionId: null,
      accountId: "ag_hermes_test",
      cwd: tmpRoot,
      signal: ctrl.signal,
      trustLevel: "owner",
    });
    expect(res.text).toBe("");
    expect(res.error).toMatch(/aborted before spawn/);
  });

  it("resolveHermesAcpCommand falls back to ~/.hermes venv when PATH lookup fails", () => {
    // Upstream `scripts/install.sh` puts hermes-acp at
    // ~/.hermes/hermes-agent/venv/bin/hermes-acp and only symlinks `hermes`
    // into ~/.local/bin. Simulate that layout: `which hermes-acp` fails,
    // but the venv path exists on disk.
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "hermes-fallback-"));
    const venvBin = path.join(fakeHome, ".hermes", "hermes-agent", "venv", "bin");
    const target = path.join(venvBin, "hermes-acp");
    mkdirSync(venvBin, { recursive: true });
    writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(target, 0o755);

    const resolved = resolveHermesAcpCommand({
      env: { PATH: "/nonexistent" },
      homeDir: fakeHome,
      execFileSyncFn: (() => {
        throw new Error("which: not found");
      }) as never,
    });
    expect(resolved).toBe(target);

    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("surfaces non-zero exit with stderr snippet", async () => {
    const p = path.join(tmpRoot, "boom.js");
    writeFileSync(
      p,
      `#!/usr/bin/env node\nprocess.stderr.write("hermes auth required\\n"); process.exit(2);\n`,
      { mode: 0o755 },
    );
    chmodSync(p, 0o755);
    const res = await runAdapter(p);
    expect(res.error).toBeDefined();
  });

  it("agent_thought_chunk emits ONLY thinking.updated status, not a block", async () => {
    const script = makeAcpServer(
      "thoughtonly.js",
      `
        if (msg.method === "initialize") {
          reply(msg, { protocolVersion: 1 });
        } else if (msg.method === "session/new") {
          reply(msg, { sessionId: "sess-thought" });
        } else if (msg.method === "session/prompt") {
          notify("session/update", { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "musing..." } } });
          notify("session/update", { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } });
          reply(msg, { stopReason: "end_turn" });
          process.stdin.pause();
          process.exit(0);
        }
      `,
    );
    const blocks: Array<{ kind: string }> = [];
    const status: Array<{ phase: string; label?: string }> = [];
    await runAdapter(script, {
      onBlock: (b) => blocks.push(b as { kind: string }),
      onStatus: (e) => {
        const ev = e as { kind: string; phase: string; label?: string };
        if (ev.kind === "thinking") status.push({ phase: ev.phase, label: ev.label });
      },
    });
    // No block was produced for the thought chunk — the only block should be
    // the assistant_message_chunk.
    const blockKinds = blocks.map((b) => b.kind);
    expect(blockKinds).not.toContain("system");
    expect(blockKinds).toContain("assistant_text");
    // But the status stream did surface the thinking.updated frame for it.
    expect(status.some((s) => s.phase === "updated" && s.label === "Thinking")).toBe(true);
    // And the prompt-done thinking.stopped fires from the ACP base.
    expect(status.some((s) => s.phase === "stopped")).toBe(true);
  });
});

describe("listHermesProfiles", () => {
  it("returns the synthetic default entry when only ~/.hermes exists", () => {
    // beforeAll set HOME to an empty tmp dir; create just ~/.hermes.
    const root = path.join(agentHomeRoot, ".hermes");
    mkdirSync(root, { recursive: true });
    // Drop a config.yaml to exercise the optional model snapshot.
    writeFileSync(
      path.join(root, "config.yaml"),
      "model:\n  default: anthropic/claude-opus-4.6\n  provider: custom\n",
    );
    writeFileSync(path.join(root, "SOUL.md"), "test soul");
    mkdirSync(path.join(root, "sessions"), { recursive: true });
    writeFileSync(path.join(root, "sessions", "20260101_abc.jsonl"), "{}\n");

    const profiles = listHermesProfiles();
    const def = profiles.find((p) => p.name === "default");
    expect(def).toBeDefined();
    expect(def?.isDefault).toBe(true);
    expect(def?.home).toBe(root);
    expect(def?.modelName).toBe("anthropic/claude-opus-4.6");
    expect(def?.hasSoul).toBe(true);
    expect(def?.sessionsCount).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });

  it("enumerates named profiles and honours active_profile", () => {
    const root = path.join(agentHomeRoot, ".hermes");
    mkdirSync(path.join(root, "profiles", "coder"), { recursive: true });
    mkdirSync(path.join(root, "profiles", "writer"), { recursive: true });
    // Garbage / invalid profile names should be skipped.
    mkdirSync(path.join(root, "profiles", "BadName"), { recursive: true });
    writeFileSync(path.join(root, "active_profile"), "writer\n");

    const profiles = listHermesProfiles();
    const names = profiles.map((p) => p.name).sort();
    expect(names).toEqual(["coder", "default", "writer"]);
    const writer = profiles.find((p) => p.name === "writer");
    expect(writer?.isActive).toBe(true);
    expect(writer?.home).toBe(hermesProfileHomeDir("writer"));

    rmSync(root, { recursive: true, force: true });
  });
});

describe("HermesAgentAdapter.spawnEnv attach mode", () => {
  it("points HERMES_HOME at the user profile when hermesProfile is set", () => {
    const adapter = new HermesAgentAdapter({ binary: "/dev/null" });
    type EnvProbe = { HERMES_HOME?: string };
    const env = (
      adapter as unknown as {
        spawnEnv: (opts: unknown) => EnvProbe;
      }
    ).spawnEnv({
      text: "",
      sessionId: null,
      cwd: tmpRoot,
      accountId: "ag_attach",
      signal: new AbortController().signal,
      trustLevel: "owner",
      hermesProfile: "coder",
    });
    expect(env.HERMES_HOME).toBe(hermesProfileHomeDir("coder"));
  });

  it("falls back to per-agent isolated home when hermesProfile is unset", () => {
    const adapter = new HermesAgentAdapter({ binary: "/dev/null" });
    type EnvProbe = { HERMES_HOME?: string };
    const env = (
      adapter as unknown as {
        spawnEnv: (opts: unknown) => EnvProbe;
      }
    ).spawnEnv({
      text: "",
      sessionId: null,
      cwd: tmpRoot,
      accountId: "ag_isolated",
      signal: new AbortController().signal,
      trustLevel: "owner",
    });
    expect(env.HERMES_HOME).toContain(path.join(".botcord", "agents", "ag_isolated"));
    expect(env.HERMES_HOME).not.toBe(hermesProfileHomeDir("default"));
  });
});
