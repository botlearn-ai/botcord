import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir = "";
let sessionsPath = "";

// Stub paths the session-store writes to so we don't touch the real ~/.botcord.
vi.mock("../config.js", () => {
  return {
    get SESSIONS_PATH() {
      return sessionsPath;
    },
    get DAEMON_DIR_PATH() {
      return tmpDir;
    },
  };
});

// Silence the log module — it touches ~/.botcord/logs and stderr.
vi.mock("../log.js", () => {
  const noop = () => {};
  return { log: { info: noop, warn: noop, error: noop, debug: noop }, LOG_FILE_PATH: "" };
});

const { Dispatcher } = await import("../dispatcher.js");
const { SessionStore } = await import("../session-store.js");
import type { DaemonConfig } from "../config.js";
import type { AgentBackend, AdapterRunOptions, AdapterRunResult } from "../adapters/types.js";
import type { BotCordClient } from "@botcord/protocol-core";
import type { InboxMessage } from "../dispatcher.js";

type MockClient = {
  pollInbox: ReturnType<typeof vi.fn>;
  ackMessages: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendTypedMessage: ReturnType<typeof vi.fn>;
  ensureToken: ReturnType<typeof vi.fn>;
  getHubUrl: ReturnType<typeof vi.fn>;
};

function makeClient(): MockClient {
  return {
    pollInbox: vi.fn().mockResolvedValue({ messages: [] }),
    ackMessages: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ message_id: "m_reply" }),
    sendTypedMessage: vi.fn().mockResolvedValue({ message_id: "m_err" }),
    ensureToken: vi.fn().mockResolvedValue("tok"),
    getHubUrl: vi.fn().mockReturnValue("https://hub.test"),
  };
}

function makeCfg(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    agentId: "ag_self",
    defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
    routes: [],
    streamBlocks: true,
    ...overrides,
  };
}

interface RecordingAdapter extends AgentBackend {
  calls: AdapterRunOptions[];
  resolveAll: () => void;
}

function recorderAdapter(result: Partial<AdapterRunResult> = {}): RecordingAdapter {
  const calls: AdapterRunOptions[] = [];
  const a: RecordingAdapter = {
    name: "claude-code",
    calls,
    resolveAll: () => {},
    run: vi.fn(async (opts: AdapterRunOptions) => {
      calls.push(opts);
      return {
        text: "reply-text",
        newSessionId: "sid-new",
        ...result,
      } satisfies AdapterRunResult;
    }),
  };
  return a;
}

interface InboxMsgInput {
  hub_msg_id?: string;
  msg_id?: string;
  from?: string;
  to?: string;
  type?: string;
  room_id?: string | null;
  topic?: string | null;
  payload?: { text?: string; [k: string]: unknown };
}

function makeInboxMsg(p: InboxMsgInput = {}): InboxMessage {
  const payload = p.payload ?? { text: "hi there" };
  return {
    hub_msg_id: p.hub_msg_id ?? "hub-1",
    envelope: {
      msg_id: p.msg_id ?? "msg-1",
      from: p.from ?? "ag_peer",
      to: p.to ?? "ag_self",
      type: p.type ?? "message",
      payload,
    },
    text: typeof payload.text === "string" ? payload.text : null,
    room_id: p.room_id ?? "rm_oc_abc",
    topic: p.topic ?? null,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "daemon-disp-"));
  sessionsPath = path.join(tmpDir, "sessions.json");
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("Dispatcher.handleMessage via drainInbox", () => {
  it("skips empty payload.text (no adapter call, no reply)", async () => {
    const client = makeClient();
    const adapter = recorderAdapter();
    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ payload: { text: "   " } })],
    });
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
    });
    await d.drainInbox();
    await new Promise((r) => setImmediate(r));
    expect(adapter.run).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.ackMessages).toHaveBeenCalledWith(["hub-1"]);
  });

  it("skips non-message envelope types", async () => {
    const client = makeClient();
    const adapter = recorderAdapter();
    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ type: "result" })],
    });
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
    });
    await d.drainInbox();
    await new Promise((r) => setImmediate(r));
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it("skips self-echo on non-owner-chat rooms but processes owner-chat self-echoes", async () => {
    const client = makeClient();
    const adapter = recorderAdapter();
    client.pollInbox
      .mockResolvedValueOnce({
        messages: [
          makeInboxMsg({ hub_msg_id: "h-peer", from: "ag_self", room_id: "rm_normal" }),
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          makeInboxMsg({ hub_msg_id: "h-oc", from: "ag_self", room_id: "rm_oc_1" }),
        ],
      });
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
    });
    await d.drainInbox();
    await new Promise((r) => setImmediate(r));
    expect(adapter.run).not.toHaveBeenCalled();

    await d.drainInbox();
    // Wait for the background handler to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  it("resolveRoute: matching roomId wins, then roomPrefix, then defaultRoute", async () => {
    const client = makeClient();
    const claude = recorderAdapter();
    const codex = recorderAdapter();
    const cfg = makeCfg({
      defaultRoute: { adapter: "claude-code", cwd: "/default" },
      routes: [
        { match: { roomId: "rm_exact" }, adapter: "codex", cwd: "/exact" },
        { match: { roomPrefix: "rm_oc_" }, adapter: "codex", cwd: "/oc" },
      ],
    });
    const d = new Dispatcher(client as unknown as BotCordClient, cfg, new SessionStore(), {
      adapters: { "claude-code": claude, codex: codex as unknown as AgentBackend },
    });

    client.pollInbox.mockResolvedValueOnce({
      messages: [
        makeInboxMsg({ hub_msg_id: "h1", room_id: "rm_exact" }),
      ],
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(codex.calls[0]?.cwd).toBe("/exact");

    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ hub_msg_id: "h2", room_id: "rm_oc_xyz" })],
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(codex.calls[1]?.cwd).toBe("/oc");

    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ hub_msg_id: "h3", room_id: "rm_other" })],
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(claude.calls[0]?.cwd).toBe("/default");
  });

  it("same turnKey aborts the in-flight turn", async () => {
    const client = makeClient();
    let firstSignal: AbortSignal | undefined;
    let releaseFirst: () => void = () => {};
    const adapter: AgentBackend = {
      name: "claude-code",
      run: vi.fn(async (opts: AdapterRunOptions) => {
        if (!firstSignal) {
          firstSignal = opts.signal;
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
            opts.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { text: "", newSessionId: "sid-1" };
        }
        return { text: "second", newSessionId: "sid-2" };
      }),
    };
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
    });
    client.pollInbox
      .mockResolvedValueOnce({
        messages: [makeInboxMsg({ hub_msg_id: "h1", msg_id: "m1", room_id: "rm_oc_a" })],
      })
      .mockResolvedValueOnce({
        messages: [makeInboxMsg({ hub_msg_id: "h2", msg_id: "m2", room_id: "rm_oc_a" })],
      });

    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 5));
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));

    expect(firstSignal?.aborted).toBe(true);
    // Second turn actually replied.
    expect(client.sendMessage).toHaveBeenCalledWith(
      "rm_oc_a",
      "second",
      expect.objectContaining({ replyTo: "m2" }),
    );
    // First turn was cancelled — should NOT have replied with its result.
    const sendCalls = client.sendMessage.mock.calls;
    expect(sendCalls.some((c) => c[1] === "" /* first turn reply */)).toBe(false);
    releaseFirst();
  });

  it("only emits stream blocks when streamBlocks && owner-chat", async () => {
    const client = makeClient();
    const adapter = recorderAdapter();
    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ room_id: "rm_other" })],
    });
    let d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls[0]?.onBlock).toBeUndefined();

    // Owner-chat AND streamBlocks=true → onBlock is set.
    const adapter2 = recorderAdapter();
    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ hub_msg_id: "h2", room_id: "rm_oc_y" })],
    });
    d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter2 },
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter2.calls[0]?.onBlock).toBeInstanceOf(Function);

    // streamBlocks=false → never emits.
    const adapter3 = recorderAdapter();
    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ hub_msg_id: "h3", room_id: "rm_oc_z" })],
    });
    d = new Dispatcher(
      client as unknown as BotCordClient,
      makeCfg({ streamBlocks: false }),
      new SessionStore(),
      { adapters: { "claude-code": adapter3 } },
    );
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter3.calls[0]?.onBlock).toBeUndefined();
  });

  it("successful turn writes session entry and replies with topic passthrough", async () => {
    const client = makeClient();
    const adapter = recorderAdapter({ text: "ok", newSessionId: "sid-xyz" });
    const store = new SessionStore();
    client.pollInbox.mockResolvedValueOnce({
      messages: [
        makeInboxMsg({
          hub_msg_id: "h1",
          msg_id: "m1",
          room_id: "rm_team_1",
          topic: "tp_plan",
        }),
      ],
    });
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), store, {
      adapters: { "claude-code": adapter },
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sendMessage).toHaveBeenCalledWith(
      "rm_team_1",
      "ok",
      { replyTo: "m1", topic: "tp_plan" },
    );
    const entry = store.get("ag_self", "rm_team_1", "tp_plan");
    expect(entry?.backendSid).toBe("sid-xyz");
    expect(entry?.backend).toBe("claude-code");
  });

  it("missing adapter on owner-chat replies with error", async () => {
    const client = makeClient();
    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ room_id: "rm_oc_n" })],
    });
    const cfg = makeCfg({
      defaultRoute: { adapter: "gemini", cwd: "/tmp" },
    });
    const d = new Dispatcher(client as unknown as BotCordClient, cfg, new SessionStore(), {
      adapters: {}, // none registered
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sendTypedMessage).toHaveBeenCalledWith(
      "rm_oc_n",
      "error",
      expect.stringContaining("gemini"),
      expect.objectContaining({ replyTo: "msg-1" }),
    );
  });

  it("adapter ENOENT on owner-chat → error reply mentions 'binary not found'", async () => {
    const client = makeClient();
    const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const adapter: AgentBackend = {
      name: "claude-code",
      run: vi.fn(async () => {
        throw err;
      }),
    };
    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ room_id: "rm_oc_x" })],
    });
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.sendTypedMessage).toHaveBeenCalledWith(
      "rm_oc_x",
      "error",
      expect.stringContaining("binary not found"),
      expect.any(Object),
    );
  });

  it("drainInbox pulls with ack=false and acks accepted ids", async () => {
    const client = makeClient();
    const adapter = recorderAdapter();
    client.pollInbox.mockResolvedValueOnce({
      messages: [
        makeInboxMsg({ hub_msg_id: "h1", msg_id: "m1", room_id: "rm_oc_a" }),
        makeInboxMsg({ hub_msg_id: "h2", msg_id: "m2", room_id: "rm_oc_a" }),
      ],
    });
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
    });
    await d.drainInbox();
    expect(client.pollInbox).toHaveBeenCalledWith({ limit: 50, ack: false });
    expect(client.ackMessages).toHaveBeenCalledWith(["h1", "h2"]);
  });

  it("duplicate hub_msg_id gets ack'd but not re-dispatched", async () => {
    const client = makeClient();
    const adapter = recorderAdapter();
    client.pollInbox
      .mockResolvedValueOnce({
        messages: [makeInboxMsg({ hub_msg_id: "h-dup", msg_id: "m1", room_id: "rm_oc_a" })],
      })
      .mockResolvedValueOnce({
        messages: [makeInboxMsg({ hub_msg_id: "h-dup", msg_id: "m1", room_id: "rm_oc_a" })],
      });
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.run).toHaveBeenCalledTimes(1);
    expect(client.ackMessages).toHaveBeenCalledTimes(2);
    expect(client.ackMessages).toHaveBeenNthCalledWith(2, ["h-dup"]);
  });

  it("turn timeout aborts adapter signal and on owner-chat emits error reply", async () => {
    const client = makeClient();
    let seenSignal: AbortSignal | undefined;
    const adapter: AgentBackend = {
      name: "claude-code",
      run: vi.fn(async (opts: AdapterRunOptions) => {
        seenSignal = opts.signal;
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "", newSessionId: "sid" };
      }),
    };
    client.pollInbox.mockResolvedValueOnce({
      messages: [makeInboxMsg({ hub_msg_id: "h1", msg_id: "m1", room_id: "rm_oc_t" })],
    });
    const d = new Dispatcher(client as unknown as BotCordClient, makeCfg(), new SessionStore(), {
      adapters: { "claude-code": adapter },
      turnTimeoutMs: 20,
    });
    await d.drainInbox();
    await new Promise((r) => setTimeout(r, 80));
    expect(seenSignal?.aborted).toBe(true);
    expect(client.sendTypedMessage).toHaveBeenCalledWith(
      "rm_oc_t",
      "error",
      expect.stringMatching(/hard cap|exceeded/),
      expect.any(Object),
    );
  });
});
