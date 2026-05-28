/**
 * Live smoke test for the Gemini adapter — runs against the compiled
 * dist/ so we don't need ts-node / tsx. Two turns: new session + --resume.
 *
 * Usage (from repo root):
 *   pnpm --filter @botcord/daemon build && \
 *     node packages/daemon/scripts/smoke-gemini.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiAdapter } from "../dist/gateway/runtimes/gemini.js";

const PROMPT_1 =
  process.env.GEMINI_SMOKE_PROMPT ??
  "Say only the single word `pong` and nothing else.";
const PROMPT_2 =
  process.env.GEMINI_SMOKE_FOLLOW ??
  "What did I just ask you to say? Reply in 3 words or fewer.";

async function runOne(adapter, label, text, sessionId, cwd) {
  const blocks = [];
  const status = [];
  const ctrl = new AbortController();
  const started = Date.now();
  const res = await adapter.run({
    text,
    sessionId,
    accountId: "ag_smoke",
    cwd,
    signal: ctrl.signal,
    trustLevel: "owner",
    onBlock: (b) => blocks.push(b.kind),
    onStatus: (e) => {
      if (e.kind === "thinking") {
        status.push(`${e.phase}${e.label ? `:${e.label}` : ""}`);
      }
    },
  });
  const elapsed = Date.now() - started;
  process.stdout.write(
    `\n=== ${label} (${elapsed}ms) ===\n` +
      `prompt:     ${JSON.stringify(text)}\n` +
      `sessionIn:  ${sessionId ?? "<none>"}\n` +
      `sessionOut: ${res.newSessionId}\n` +
      `text:       ${JSON.stringify(res.text)}\n` +
      `error:      ${res.error ?? "<none>"}\n` +
      `blocks:     [${blocks.join(", ")}]\n` +
      `status:     [${status.join(", ")}]\n`,
  );
  return res;
}

const cwd = mkdtempSync(path.join(os.tmpdir(), "gemini-smoke-"));
process.stdout.write(`smoke cwd: ${cwd}\n`);

const adapter = new GeminiAdapter();
try {
  const turn1 = await runOne(adapter, "turn 1 (new session)", PROMPT_1, null, cwd);
  if (!turn1.newSessionId) {
    process.stderr.write("FAIL: turn 1 returned no newSessionId\n");
    process.exit(1);
  }
  if (turn1.error) {
    process.stderr.write(`FAIL: turn 1 error: ${turn1.error}\n`);
    process.exit(1);
  }

  const turn2 = await runOne(
    adapter,
    "turn 2 (--resume)",
    PROMPT_2,
    turn1.newSessionId,
    cwd,
  );
  if (turn2.error) {
    process.stderr.write(`FAIL: turn 2 error: ${turn2.error}\n`);
    process.exit(1);
  }
  if (!turn2.text.trim()) {
    process.stderr.write("FAIL: turn 2 returned empty text\n");
    process.exit(1);
  }

  process.stdout.write("\nOK: both turns succeeded.\n");
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
