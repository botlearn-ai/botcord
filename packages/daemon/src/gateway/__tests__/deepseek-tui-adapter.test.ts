import { afterAll, describe, expect, it } from "vitest";
import http, { type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeepseekTuiAdapter } from "../runtimes/deepseek-tui.js";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "gateway-deepseek-tui-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startMockDeepseekServer(opts?: {
  token?: string;
  threadId?: string;
  turnId?: string;
  events?: Array<{ event: string; data: unknown }>;
}) {
  const token = opts?.token ?? "test-token";
  const threadId = opts?.threadId ?? "thr_test";
  const turnId = opts?.turnId ?? "turn_test";
  const events =
    opts?.events ??
    [
      { event: "turn.started", data: { thread_id: threadId, turn_id: turnId } },
      { event: "tool.started", data: { id: "tool_1", name: "shell", input: { command: "pwd" } } },
      { event: "tool.completed", data: { id: "tool_1", success: true, output: "/tmp" } },
      { event: "message.delta", data: { thread_id: threadId, turn_id: turnId, content: "hello " } },
      { event: "message.delta", data: { thread_id: threadId, turn_id: turnId, content: "deepseek" } },
      { event: "turn.completed", data: { thread_id: threadId, turn_id: turnId, usage: {} } },
    ];

  const calls: Array<{ method: string; url: string; body?: any; auth?: string }> = [];
  let eventRes: ServerResponse | null = null;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        auth: req.headers.authorization,
      });

      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/threads") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: threadId }));
        return;
      }
      if (req.method === "PATCH" && req.url === `/v1/threads/${threadId}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: threadId }));
        return;
      }
      if (req.method === "GET" && req.url === `/v1/threads/${threadId}/events?since_seq=0`) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        eventRes = res;
        return;
      }
      if (req.method === "POST" && req.url === `/v1/threads/${threadId}/turns`) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ thread: { id: threadId }, turn: { id: turnId } }));
        setTimeout(() => {
          for (const ev of events) eventRes?.write(sse(ev.event, ev.data));
          eventRes?.end();
        }, 5);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    token,
    threadId,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runAdapter(serverUrl: string, authToken: string, sessionId: string | null = null) {
  const adapter = new DeepseekTuiAdapter({ serverUrl, authToken });
  const ctrl = new AbortController();
  const blocks: string[] = [];
  const status: Array<{ phase: string; label?: string }> = [];
  const result = adapter.run({
    text: "hi",
    sessionId,
    accountId: "ag_deepseek",
    cwd: tmpRoot,
    signal: ctrl.signal,
    trustLevel: "owner",
    systemContext: "runtime memory",
    onBlock: (b) => blocks.push(b.kind),
    onStatus: (e) => {
      if (e.kind === "thinking") status.push({ phase: e.phase, label: e.label });
    },
  });
  return { result, blocks, status };
}

describe("DeepseekTuiAdapter", () => {
  it("creates a thread, starts a turn, parses SSE assistant text, and emits tool blocks", async () => {
    const server = await startMockDeepseekServer();
    try {
      const { result, blocks, status } = runAdapter(server.baseUrl, server.token);
      const res = await result;
      expect(res).toEqual({ text: "hello deepseek", newSessionId: server.threadId });
      expect(blocks).toContain("tool_use");
      expect(blocks).toContain("tool_result");
      expect(blocks).toContain("assistant_text");
      expect(status).toContainEqual({ phase: "started", label: "Thinking" });
      expect(status).toContainEqual({ phase: "updated", label: "shell" });
      expect(status.at(-1)).toEqual({ phase: "stopped", label: undefined });
      expect(server.calls.find((c) => c.method === "POST" && c.url === "/v1/threads")?.body).toMatchObject({
        workspace: tmpRoot,
        system_prompt: "runtime memory",
        auto_approve: true,
      });
    } finally {
      await server.close();
    }
  });

  it("reuses an existing DeepSeek thread id and patches per-turn system context", async () => {
    const server = await startMockDeepseekServer({ threadId: "thr_existing" });
    try {
      const { result } = runAdapter(server.baseUrl, server.token, "thr_existing");
      const res = await result;
      expect(res.newSessionId).toBe("thr_existing");
      expect(server.calls.some((c) => c.method === "POST" && c.url === "/v1/threads")).toBe(false);
      const patch = server.calls.find((c) => c.method === "PATCH");
      expect(patch?.url).toBe("/v1/threads/thr_existing");
      expect(patch?.body).toEqual({ system_prompt: "runtime memory" });
    } finally {
      await server.close();
    }
  });

  it("clears stale session ids when DeepSeek reports the thread missing", async () => {
    const server = await startMockDeepseekServer({ threadId: "thr_other" });
    try {
      const adapter = new DeepseekTuiAdapter({ serverUrl: server.baseUrl, authToken: server.token });
      const ctrl = new AbortController();
      const res = await adapter.run({
        text: "hi",
        sessionId: "thr_missing",
        accountId: "ag_deepseek",
        cwd: tmpRoot,
        signal: ctrl.signal,
        trustLevel: "owner",
      });
      expect(res.newSessionId).toBe("");
      expect(res.error).toMatch(/HTTP 404/);
    } finally {
      await server.close();
    }
  });

  it("returns a runtime error when DeepSeek completes the turn as failed", async () => {
    const server = await startMockDeepseekServer({
      events: [
        { event: "turn.started", data: { thread_id: "thr_test", turn_id: "turn_test" } },
        {
          event: "turn.completed",
          data: {
            thread_id: "thr_test",
            turn_id: "turn_test",
            payload: { turn: { status: "failed", error: "missing api key" } },
          },
        },
      ],
    });
    try {
      const { result } = runAdapter(server.baseUrl, server.token);
      const res = await result;
      expect(res.text).toBe("");
      expect(res.newSessionId).toBe("thr_test");
      expect(res.error).toBe("missing api key");
    } finally {
      await server.close();
    }
  });
});
