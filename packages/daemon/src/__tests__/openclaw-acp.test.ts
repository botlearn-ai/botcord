import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  OpenclawAcpAdapter,
  __resetOpenclawAcpPoolForTests,
  buildAcpSessionKey,
} from "../gateway/runtimes/openclaw-acp.js";
import type { ResolvedOpenclawGateway } from "../gateway/types.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
  }
}

function makeSpawn(child: FakeChild): any {
  return () => child as unknown as ReturnType<typeof import("node:child_process").spawn>;
}

function readFrames(child: FakeChild): Promise<any[]> {
  return new Promise((resolve) => {
    const frames: any[] = [];
    child.stdin.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split("\n").filter(Boolean);
      for (const line of lines) frames.push(JSON.parse(line));
    });
    setTimeout(() => resolve(frames), 50);
  });
}

afterEach(() => {
  __resetOpenclawAcpPoolForTests();
});

describe("buildAcpSessionKey", () => {
  it("includes accountId so two daemon agents can't collide on a gateway key", () => {
    const a = buildAcpSessionKey({
      openclawAgent: "main",
      accountId: "ag_alice",
      conversationKey: "rm_x",
    });
    const b = buildAcpSessionKey({
      openclawAgent: "main",
      accountId: "ag_bob",
      conversationKey: "rm_x",
    });
    expect(a).not.toBe(b);
    expect(a).toContain("ag_alice");
    expect(b).toContain("ag_bob");
  });
});

describe("OpenclawAcpAdapter.run", () => {
  it("fails fast when gateway is not provided", async () => {
    const adapter = new OpenclawAcpAdapter({ spawnFn: makeSpawn(new FakeChild()) });
    const res = await adapter.run({
      text: "hi",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner",
    });
    expect(res.error).toMatch(/missing gateway/);
  });

  it("defaults to OpenClaw's default agent when gateway has no openclawAgent resolved", async () => {
    const child = new FakeChild();
    const adapter = new OpenclawAcpAdapter({ spawnFn: makeSpawn(child) });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
    };
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame.method === "initialize") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
        } else if (frame.method === "session/new") {
          expect(frame.params._meta.sessionKey).toContain("agent:default:");
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "sid-default" } }) + "\n");
        } else if (frame.method === "session/prompt") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "ok" } }) + "\n");
        }
      }
    });
    const res = await adapter.run({
      text: "hi",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner",
      gateway,
    });
    expect(res.text).toBe("ok");
  });

  it("performs initialize → newSession → prompt and returns final text", async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const adapter = new OpenclawAcpAdapter({ spawnFn: spawnFn as any });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
      openclawAgent: "main",
    };

    // Seed the child stdout with replies as soon as stdin is written.
    let nextSessionId = "acp-uuid-1";
    let promptId: number | null = null;
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame.method === "initialize") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
        } else if (frame.method === "session/new") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: nextSessionId } }) + "\n");
        } else if (frame.method === "session/prompt") {
          promptId = frame.id;
          // Stream a chunk then resolve.
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: nextSessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { text: "hello world" } },
              },
            }) + "\n",
          );
          setTimeout(() => {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { text: "hello world" } }) + "\n");
          }, 5);
        }
      }
    });

    const blocks: any[] = [];
    const res = await adapter.run({
      text: "hi",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner",
      gateway,
      onBlock: (b) => blocks.push(b),
    });

    expect(res.error).toBeUndefined();
    expect(res.text).toBe("hello world");
    expect(res.newSessionId).toBe("acp-uuid-1");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].kind).toBe("assistant_text");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][1]).toEqual(["acp", "--url", "ws://127.0.0.1:1"]);
  });

  it("returns an error instead of empty text when OpenClaw emits warnings and no assistant text", async () => {
    const child = new FakeChild();
    const adapter = new OpenclawAcpAdapter({ spawnFn: makeSpawn(child) });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
      openclawAgent: "main",
    };

    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame.method === "initialize") {
          child.stdout.write("◇  Config warnings ─────────────────────╮\n");
          child.stdout.write("│  - models.providers.foo.apiKey: Missing env var FOO_API_KEY │\n");
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
        } else if (frame.method === "session/new") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "sid-warn" } }) + "\n");
        } else if (frame.method === "session/prompt") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "error" } }) + "\n");
        }
      }
    });

    const res = await adapter.run({
      text: "hi",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner",
      gateway,
    });

    expect(res.text).toBe("");
    expect(res.newSessionId).toBe("sid-warn");
    expect(res.error).toContain("prompt stopped: error");
    expect(res.error).toContain("Missing env var FOO_API_KEY");
  });

  it("streams only final text when OpenClaw sends reasoning before a final block", async () => {
    const child = new FakeChild();
    const adapter = new OpenclawAcpAdapter({ spawnFn: makeSpawn(child) });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
      openclawAgent: "main",
    };

    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame.method === "initialize") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
        } else if (frame.method === "session/new") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "sid-final" } }) + "\n");
        } else if (frame.method === "session/prompt") {
          for (const text of [
            "The user is asking for my location. I need to check it. ",
            "<fin",
            "al>The answer is Council Bluffs.",
            "</final>",
          ]) {
            child.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "sid-final",
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
                },
              }) + "\n",
            );
          }
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: frame.id,
              result: { text: "The user is asking for my location. I need to check it." },
            }) + "\n",
          );
        }
      }
    });

    const blocks: any[] = [];
    const res = await adapter.run({
      text: "what's your current location",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner",
      gateway,
      onBlock: (b) => blocks.push(b),
    });

    expect(res.text).toBe("The answer is Council Bluffs.");
    expect(blocks.filter((b) => b.kind === "assistant_text").map((b) => b.raw.params.update.content[0].text).join("")).toBe(
      "The answer is Council Bluffs.",
    );
  });

  it("respawns the pooled child when gateway.url or gateway.token changes under the same name", async () => {
    function newChild(): FakeChild {
      const c = new FakeChild();
      c.stdin.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          if (frame.method === "initialize") {
            c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\n");
          } else if (frame.method === "session/new") {
            c.stdout.write(
              JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "s" } }) + "\n",
            );
          } else if (frame.method === "session/prompt") {
            c.stdout.write(
              JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "ok" } }) + "\n",
            );
          }
        }
      });
      return c;
    }
    const children = [newChild(), newChild(), newChild()];
    const spawnFn = vi.fn().mockImplementation(() => children.shift()! as any);
    const adapter = new OpenclawAcpAdapter({ spawnFn: spawnFn as any });
    const baseOpts = {
      text: "hi",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner" as const,
    };
    await adapter.run({
      ...baseOpts,
      gateway: { name: "p1", url: "ws://a", token: "t1", openclawAgent: "main" },
    });
    await adapter.run({
      ...baseOpts,
      gateway: { name: "p1", url: "ws://b", token: "t1", openclawAgent: "main" },
    });
    await adapter.run({
      ...baseOpts,
      gateway: { name: "p1", url: "ws://b", token: "t2", openclawAgent: "main" },
    });
    expect(spawnFn).toHaveBeenCalledTimes(3);
  });

  it("reuses the pooled child for the same (accountId, gateway)", async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const adapter = new OpenclawAcpAdapter({ spawnFn: spawnFn as any });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
      openclawAgent: "main",
    };

    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame.method === "initialize") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
        } else if (frame.method === "session/load") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: frame.params.sessionId } }) + "\n");
        } else if (frame.method === "session/new") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "s1" } }) + "\n");
        } else if (frame.method === "session/prompt") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "ok" } }) + "\n");
        }
      }
    });

    const opts = {
      text: "hi",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner" as const,
      gateway,
    };
    await adapter.run(opts);
    await adapter.run({ ...opts, sessionId: "s1" });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("loads a cached ACP session id with the stable sessionKey before prompting", async () => {
    const child = new FakeChild();
    const adapter = new OpenclawAcpAdapter({ spawnFn: makeSpawn(child) });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
      openclawAgent: "swe",
    };
    const seen: any[] = [];

    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        seen.push(frame);
        if (frame.method === "initialize") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
        } else if (frame.method === "session/load") {
          expect(frame.params.sessionId).toBe("cached-id");
          expect(frame.params._meta.sessionKey).toBe(
            "agent:swe:ag_337518f31844:direct:rm_oc_owner",
          );
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "cached-id" } }) + "\n");
        } else if (frame.method === "session/prompt") {
          expect(frame.params.sessionId).toBe("cached-id");
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "loaded ok" } }) + "\n");
        }
      }
    });

    const res = await adapter.run({
      text: "hi",
      sessionId: "cached-id",
      cwd: "/tmp",
      accountId: "ag_337518f31844",
      signal: new AbortController().signal,
      trustLevel: "owner",
      gateway,
      context: { conversationKey: "direct:rm_oc_owner" },
    });

    expect(res.error).toBeUndefined();
    expect(res.text).toBe("loaded ok");
    expect(res.newSessionId).toBe("cached-id");
    expect(seen.map((f) => f.method)).toEqual(["initialize", "session/load", "session/prompt"]);
  });

  it("discards a cached ACP session id when session/load reports not found", async () => {
    const child = new FakeChild();
    const adapter = new OpenclawAcpAdapter({ spawnFn: makeSpawn(child) });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
      openclawAgent: "swe",
    };
    const seen: any[] = [];

    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        seen.push(frame);
        if (frame.method === "initialize") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
        } else if (frame.method === "session/load") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: frame.id,
              error: {
                code: -32603,
                message: "Internal error",
                data: { details: "Session cached-id not found" },
              },
            }) + "\n",
          );
        } else if (frame.method === "session/new") {
          expect(frame.params._meta.sessionKey).toBe(
            "agent:swe:ag_337518f31844:direct:rm_oc_owner",
          );
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "fresh-id" } }) + "\n");
        } else if (frame.method === "session/prompt") {
          expect(frame.params.sessionId).toBe("fresh-id");
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "fresh ok" } }) + "\n");
        }
      }
    });

    const res = await adapter.run({
      text: "hi",
      sessionId: "cached-id",
      cwd: "/tmp",
      accountId: "ag_337518f31844",
      signal: new AbortController().signal,
      trustLevel: "owner",
      gateway,
      context: { conversationKey: "direct:rm_oc_owner" },
    });

    expect(res.error).toBeUndefined();
    expect(res.text).toBe("fresh ok");
    expect(res.newSessionId).toBe("fresh-id");
    expect(seen.map((f) => f.method)).toEqual([
      "initialize",
      "session/load",
      "session/new",
      "session/prompt",
    ]);
  });

  it("recreates the ACP session and retries once when prompt reports not found", async () => {
    const child = new FakeChild();
    const adapter = new OpenclawAcpAdapter({ spawnFn: makeSpawn(child) });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
      openclawAgent: "swe",
    };
    const seen: any[] = [];

    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        seen.push(frame);
        if (frame.method === "initialize") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
        } else if (frame.method === "session/load") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "cached-id" } }) + "\n");
        } else if (frame.method === "session/new") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "fresh-id" } }) + "\n");
        } else if (frame.method === "session/prompt" && frame.params.sessionId === "cached-id") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: frame.id,
              error: {
                code: -32603,
                message: "Internal error",
                data: { details: "Session cached-id not found" },
              },
            }) + "\n",
          );
        } else if (frame.method === "session/prompt") {
          expect(frame.params.sessionId).toBe("fresh-id");
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "retry ok" } }) + "\n");
        }
      }
    });

    const res = await adapter.run({
      text: "hi",
      sessionId: "cached-id",
      cwd: "/tmp",
      accountId: "ag_337518f31844",
      signal: new AbortController().signal,
      trustLevel: "owner",
      gateway,
      context: { conversationKey: "direct:rm_oc_owner" },
    });

    expect(res.error).toBeUndefined();
    expect(res.text).toBe("retry ok");
    expect(res.newSessionId).toBe("fresh-id");
    expect(seen.map((f) => f.method)).toEqual([
      "initialize",
      "session/load",
      "session/prompt",
      "session/new",
      "session/prompt",
    ]);
  });
});
