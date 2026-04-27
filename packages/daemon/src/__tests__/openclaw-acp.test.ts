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

  it("fails when gateway has no openclawAgent resolved", async () => {
    const adapter = new OpenclawAcpAdapter({ spawnFn: makeSpawn(new FakeChild()) });
    const gateway: ResolvedOpenclawGateway = {
      name: "local",
      url: "ws://127.0.0.1:1",
    };
    const res = await adapter.run({
      text: "hi",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner",
      gateway,
    });
    expect(res.error).toMatch(/openclawAgent/);
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

  it("respawns the pooled child when gateway.url or gateway.token changes", async () => {
    // Each call to spawnFn must hand back a fresh child — the second `run`
    // should detect the rotated token and shut down the first child before
    // spawning a new one.
    const childA = new FakeChild();
    const childB = new FakeChild();
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(childA)
      .mockReturnValueOnce(childB);
    const adapter = new OpenclawAcpAdapter({ spawnFn: spawnFn as any });

    function wireChild(c: FakeChild, sid: string): void {
      c.stdin.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          if (frame.method === "initialize") {
            c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } }) + "\n");
          } else if (frame.method === "session/new") {
            c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: sid } }) + "\n");
          } else if (frame.method === "session/prompt") {
            c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "ok" } }) + "\n");
          }
        }
      });
    }
    wireChild(childA, "s1");
    wireChild(childB, "s2");

    const baseOpts = {
      text: "hi",
      sessionId: null,
      cwd: "/tmp",
      accountId: "ag_alice",
      signal: new AbortController().signal,
      trustLevel: "owner" as const,
    };
    const gatewayV1: ResolvedOpenclawGateway = {
      name: "remote",
      url: "ws://10.0.0.1:8080",
      token: "token-old",
      openclawAgent: "main",
    };
    const gatewayV2: ResolvedOpenclawGateway = {
      ...gatewayV1,
      token: "token-rotated",
    };

    await adapter.run({ ...baseOpts, gateway: gatewayV1 });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][1]).toContain("token-old");
    expect(childA.killed).toBe(false);

    await adapter.run({ ...baseOpts, gateway: gatewayV2 });
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[1][1]).toContain("token-rotated");
    // The stale child must have been signaled.
    expect(childA.killed).toBe(true);
  });
});
