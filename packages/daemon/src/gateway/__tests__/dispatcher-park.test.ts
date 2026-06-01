/**
 * Integration tests for the agent-driven `botcord wait` park / re-wake path.
 *
 * A group-room turn can write a park marker (here simulated via the fake
 * runtime's `observeRun`, standing in for the `botcord wait` CLI writing to
 * `BOTCORD_WAIT_FILE` = `opts.waitMarkerFile`). The dispatcher reads it at the
 * turn boundary and re-dispatches the same message after the (clamped) wait —
 * unless a new message arrives first, or the per-queue caps are hit.
 */
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dispatcher, type RuntimeFactory } from "../dispatcher.js";
import { SessionStore } from "../session-store.js";
import { WAIT_MARKER_FILENAME } from "../wait-marker.js";
import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  GatewayConfig,
  GatewayInboundEnvelope,
  GatewayInboundMessage,
  RuntimeAdapter,
  RuntimeRunOptions,
  RuntimeRunResult,
} from "../types.js";
import type { GatewayLogger } from "../log.js";

function silentLogger(): GatewayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

class FakeChannel implements ChannelAdapter {
  readonly id = "botcord";
  readonly type = "botcord";
  readonly sends: ChannelSendContext[] = [];
  async start(): Promise<void> {}
  async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
    this.sends.push(ctx);
    return {};
  }
}

class FakeRuntime implements RuntimeAdapter {
  readonly id = "claude-code";
  readonly calls: RuntimeRunOptions[] = [];
  constructor(private readonly observeRun?: (opts: RuntimeRunOptions, callNo: number) => void) {}
  async run(options: RuntimeRunOptions): Promise<RuntimeRunResult> {
    this.calls.push(options);
    this.observeRun?.(options, this.calls.length);
    return { text: "NO_REPLY", newSessionId: "" };
  }
}

/** Simulate `botcord wait <s>`: write a park marker to the path the dispatcher
 *  handed the subprocess via `BOTCORD_WAIT_FILE` (`opts.waitMarkerFile`). Falls
 *  back to the legacy cwd path when unset, so non-eligible rooms still "write"
 *  somewhere the dispatcher will never consume. */
function writeMarker(opts: RuntimeRunOptions, deadlineFromNowMs: number): void {
  const target = opts.waitMarkerFile ?? path.join(opts.cwd, WAIT_MARKER_FILENAME);
  writeFileSync(target, JSON.stringify({ deadlineMs: Date.now() + deadlineFromNowMs }), "utf8");
}

const GROUP_CONVO = { id: "rm_grp1", kind: "group" as const };
const OWNER_CONVO = { id: "rm_oc_1", kind: "group" as const };
const DM_CONVO = { id: "rm_dm_1", kind: "direct" as const };

function makeEnvelope(partial: Partial<GatewayInboundMessage> = {}): GatewayInboundEnvelope {
  return {
    message: {
      id: partial.id ?? "hub_msg_1",
      channel: "botcord",
      accountId: "ag_me",
      conversation: partial.conversation ?? GROUP_CONVO,
      sender: partial.sender ?? { id: "ag_peer", name: "peer", kind: "agent" },
      text: partial.text ?? "anyone know how to fix this?",
      raw: {},
      replyTo: null,
      receivedAt: Date.now(),
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Dispatcher — botcord wait park/re-wake", () => {
  let cwd: string;
  let storeDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "park-cwd-"));
    storeDir = await mkdtemp(path.join(tmpdir(), "park-store-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  });

  async function scaffold(runtime: FakeRuntime) {
    const store = new SessionStore({ path: path.join(storeDir, "sessions.json") });
    await store.load();
    const channel = new FakeChannel();
    const config: GatewayConfig = {
      channels: [{ id: "botcord", type: "botcord", accountId: "ag_me" }],
      defaultRoute: { runtime: "claude-code", cwd },
      routes: [],
    };
    const dispatcher = new Dispatcher({
      config,
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: (() => runtime) as RuntimeFactory,
      sessionStore: store,
      log: silentLogger(),
    });
    return { dispatcher };
  }

  it("re-wakes a group-room turn after the marker deadline", async () => {
    const runtime = new FakeRuntime((opts, callNo) => {
      if (callNo === 1) writeMarker(opts, 40);
    });
    const { dispatcher } = await scaffold(runtime);

    await dispatcher.handle(makeEnvelope());
    expect(runtime.calls.length).toBe(1);
    expect(runtime.calls[0]!.waitMarkerFile).toBeTruthy(); // env wired for group room

    await sleep(140);
    expect(runtime.calls.length).toBe(2); // original + one re-wake
  });

  it("a new inbound during the park cancels the scheduled re-wake", async () => {
    const runtime = new FakeRuntime((opts, callNo) => {
      if (callNo === 1) writeMarker(opts, 300);
    });
    const { dispatcher } = await scaffold(runtime);

    await dispatcher.handle(makeEnvelope({ id: "m1" }));
    expect(runtime.calls.length).toBe(1);
    await dispatcher.handle(makeEnvelope({ id: "m2", text: "never mind, solved it" }));
    expect(runtime.calls.length).toBe(2);

    await sleep(380);
    expect(runtime.calls.length).toBe(2); // no phantom third turn
  });

  it("stops re-waking after MAX_PARKS consecutive parks", async () => {
    const runtime = new FakeRuntime((opts) => writeMarker(opts, 30));
    const { dispatcher } = await scaffold(runtime);

    await dispatcher.handle(makeEnvelope());
    await sleep(360);
    expect(runtime.calls.length).toBe(4); // 1 original + MAX_PARKS (3) re-wakes
  });

  it("isolates concurrent group-room turns for the same agent/cwd", async () => {
    vi.useFakeTimers();
    // Two different group rooms → two queues → two markers under one workspace.
    // Each parks once; neither clobbers the other.
    const parked = new Set<string>();
    const runtime = new FakeRuntime((opts) => {
      const room = String(opts.context?.roomId ?? "");
      if (!parked.has(room)) {
        parked.add(room);
        writeMarker(opts, 40);
      }
    });
    const { dispatcher } = await scaffold(runtime);

    await Promise.all([
      dispatcher.handle(makeEnvelope({ id: "a1", conversation: { id: "rm_gA", kind: "group" } })),
      dispatcher.handle(makeEnvelope({ id: "b1", conversation: { id: "rm_gB", kind: "group" } })),
    ]);
    expect(runtime.calls.length).toBe(2);
    // Distinct per-queue marker paths.
    expect(runtime.calls[0]!.waitMarkerFile).not.toBe(runtime.calls[1]!.waitMarkerFile);

    await vi.advanceTimersByTimeAsync(160);
    // Both rooms re-woke exactly once → 4 total, not 2 (one swallowed) or 3.
    expect(runtime.calls.length).toBe(4);
    const reWokenRooms = runtime.calls.map((c) => c.context?.roomId).sort();
    expect(reWokenRooms).toEqual(["rm_gA", "rm_gA", "rm_gB", "rm_gB"]);
  });

  it("ignores the marker in an owner-chat room", async () => {
    const runtime = new FakeRuntime((opts) => writeMarker(opts, 40));
    const { dispatcher } = await scaffold(runtime);

    await dispatcher.handle(makeEnvelope({ conversation: OWNER_CONVO }));
    expect(runtime.calls[0]!.waitMarkerFile).toBeUndefined(); // not park-eligible
    await sleep(140);
    expect(runtime.calls.length).toBe(1);
  });

  it("ignores the marker in a non-group (DM) room", async () => {
    const runtime = new FakeRuntime((opts) => writeMarker(opts, 40));
    const { dispatcher } = await scaffold(runtime);

    await dispatcher.handle(makeEnvelope({ conversation: DM_CONVO }));
    expect(runtime.calls[0]!.waitMarkerFile).toBeUndefined();
    await sleep(140);
    expect(runtime.calls.length).toBe(1);
  });
});
