/**
 * Live smoke test for tool-use through the Gemini adapter. Seeds a file
 * into the workspace cwd, then asks gemini to read it and report the
 * contents back — exercising the tool_use / tool_result event path.
 *
 * Usage:
 *   pnpm --filter @botcord/daemon build && \
 *     node packages/daemon/scripts/smoke-gemini-tool.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiAdapter } from "../dist/gateway/runtimes/gemini.js";

const cwd = mkdtempSync(path.join(os.tmpdir(), "gemini-tool-smoke-"));
const sentinel = "blue parakeet";
writeFileSync(path.join(cwd, "secret.txt"), `the password is ${sentinel}\n`);

process.stdout.write(`smoke cwd: ${cwd}\n`);

const adapter = new GeminiAdapter();
const blocks = [];
const status = [];
const ctrl = new AbortController();
const res = await adapter.run({
  text: `Read the file secret.txt in the current directory and tell me the password it stores. Reply with just the password phrase, nothing else.`,
  sessionId: null,
  accountId: "ag_tool_smoke",
  cwd,
  signal: ctrl.signal,
  trustLevel: "owner",
  onBlock: (b) => blocks.push({ kind: b.kind, type: b.raw?.type, role: b.raw?.role, tool: b.raw?.tool_name }),
  onStatus: (e) => {
    if (e.kind === "thinking") {
      status.push(`${e.phase}${e.label ? `:${e.label}` : ""}`);
    }
  },
});

process.stdout.write(
  `\n=== tool-use turn ===\n` +
    `sessionOut: ${res.newSessionId}\n` +
    `text:       ${JSON.stringify(res.text)}\n` +
    `error:      ${res.error ?? "<none>"}\n` +
    `status:     [${status.join(", ")}]\n` +
    `blocks (${blocks.length}):\n`,
);
for (const b of blocks) {
  process.stdout.write(`  - ${b.kind.padEnd(14)} type=${b.type ?? ""}${b.role ? ` role=${b.role}` : ""}${b.tool ? ` tool=${b.tool}` : ""}\n`);
}

const toolUses = blocks.filter((b) => b.kind === "tool_use");
const toolResults = blocks.filter((b) => b.kind === "tool_result");
process.stdout.write(`\ntool_use blocks:    ${toolUses.length}\n`);
process.stdout.write(`tool_result blocks: ${toolResults.length}\n`);

if (toolUses.length === 0) {
  process.stderr.write("WARN: no tool_use observed — model may have answered without reading the file.\n");
}

if (!res.text.toLowerCase().includes(sentinel.toLowerCase())) {
  process.stderr.write(`FAIL: response did not include sentinel ${JSON.stringify(sentinel)}\n`);
  rmSync(cwd, { recursive: true, force: true });
  process.exit(1);
}

process.stdout.write(`\nOK: model recovered sentinel via tool use.\n`);
rmSync(cwd, { recursive: true, force: true });
