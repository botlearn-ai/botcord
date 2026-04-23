import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  buildDaemonWebSocketUrl,
  CONTROL_FRAME_TYPES,
  generateKeypair,
  type ControlFrame,
} from "@botcord/protocol-core";
import { sign as nodeSign } from "node:crypto";
import { ControlChannel, controlSigningInput } from "../control-channel.js";
import { UserAuthManager, type UserAuthRecord } from "../user-auth.js";
import * as userAuthModule from "../user-auth.js";

function makeAuthRecord(overrides: Partial<UserAuthRecord> = {}): UserAuthRecord {
  return {
    version: 1,
    userId: "usr_1",
    daemonInstanceId: "dm_1",
    hubUrl: "http://localhost:9000",
    accessToken: "at_1",
    refreshToken: "rt_1",
    expiresAt: Date.now() + 60 * 60_000,
    loggedInAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Minimal in-memory fake of `ws` that mimics what ControlChannel uses:
 * `open` event after construction, `message`/`close`/`error` listeners,
 * `ping()`, `send()`, `close()`, and `readyState`. Each instance records
 * the URL + headers it was constructed with.
 */
class FakeWebSocket extends EventEmitter {
  public readyState = 0;
  public sent: string[] = [];
  public closed = false;
  static OPEN = 1;
  constructor(public url: string, public opts: { headers?: Record<string, string> } = {}) {
    super();
    setImmediate(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    /* noop for tests */
  }
  close(): void {
    this.closed = true;
    this.emit("close", 1000, Buffer.from("test"));
  }
  static readonly instances: FakeWebSocket[] = [];
}

function makeFakeCtor(): typeof FakeWebSocket & ((url: string, opts?: unknown) => FakeWebSocket) {
  // The ControlChannel uses `new this.webSocketCtor(url, { headers })`.
  // We capture each instance for assertions.
  function Ctor(url: string, opts: { headers?: Record<string, string> } = {}) {
    const ws = new FakeWebSocket(url, opts);
    FakeWebSocket.instances.push(ws);
    return ws;
  }
  // Inherit static OPEN + readonly enum used by ControlChannel.
  (Ctor as unknown as { OPEN: number }).OPEN = FakeWebSocket.OPEN;
  return Ctor as unknown as typeof FakeWebSocket & ((url: string, opts?: unknown) => FakeWebSocket);
}

describe("buildDaemonWebSocketUrl", () => {
  it("appends a label query string when provided", () => {
    const url = buildDaemonWebSocketUrl("http://localhost:9000", "/daemon/ws", {
      label: "MacBook Pro",
    });
    expect(url).toContain("ws://localhost:9000/daemon/ws?");
    expect(url).toContain("label=MacBook+Pro");
  });

  it("omits the query string when no label", () => {
    expect(buildDaemonWebSocketUrl("http://localhost:9000", "/daemon/ws")).toBe(
      "ws://localhost:9000/daemon/ws",
    );
  });
});

describe("ControlChannel — label propagation", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
  });

  it("sends the label from auth.current.label as ?label= on connect", async () => {
    const auth = new UserAuthManager({
      record: makeAuthRecord({ label: "MacBook Pro" }),
      file: "/tmp/never-written-user-auth.json",
    });
    const ctor = makeFakeCtor();
    const ch = new ControlChannel({
      auth,
      handle: () => ({ ok: true }),
      webSocketCtor: ctor as unknown as typeof import("ws").default,
      hubPublicKey: null,
    });
    await ch.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("label=MacBook+Pro");
    await ch.stop();
  });

  it("explicit opts.label overrides the persisted label", async () => {
    const auth = new UserAuthManager({
      record: makeAuthRecord({ label: "Old" }),
      file: "/tmp/never-written-user-auth.json",
    });
    const ctor = makeFakeCtor();
    const ch = new ControlChannel({
      auth,
      handle: () => ({ ok: true }),
      label: "New",
      webSocketCtor: ctor as unknown as typeof import("ws").default,
      hubPublicKey: null,
    });
    await ch.start();
    expect(FakeWebSocket.instances[0].url).toContain("label=New");
    await ch.stop();
  });

  it("omits the query string when there is no label anywhere", async () => {
    const auth = new UserAuthManager({
      record: makeAuthRecord(),
      file: "/tmp/never-written-user-auth.json",
    });
    const ctor = makeFakeCtor();
    const ch = new ControlChannel({
      auth,
      handle: () => ({ ok: true }),
      webSocketCtor: ctor as unknown as typeof import("ws").default,
      hubPublicKey: null,
    });
    await ch.start();
    expect(FakeWebSocket.instances[0].url).not.toContain("?");
    await ch.stop();
  });
});

describe("ControlChannel — Hub signature verification", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
  });

  function ed25519PrivateKeyForSigning(seedB64: string) {
    // Mirror protocol-core/crypto.ts privateKeyFromSeed.
    const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const seed = Buffer.from(seedB64, "base64");
    return require("node:crypto").createPrivateKey({
      key: Buffer.concat([prefix, seed]),
      format: "der",
      type: "pkcs8",
    });
  }

  function signFrame(frame: Omit<ControlFrame, "sig">, privateKeyB64: string): ControlFrame {
    const input = controlSigningInput(frame);
    const pk = ed25519PrivateKeyForSigning(privateKeyB64);
    const sig = nodeSign(null, Buffer.from(input, "utf8"), pk).toString("base64");
    return { ...frame, sig };
  }

  it("accepts and dispatches a properly-signed frame", async () => {
    const { privateKey, publicKey } = generateKeypair();
    const handler = vi.fn(async () => ({ ok: true, result: { handled: true } }));
    const auth = new UserAuthManager({
      record: makeAuthRecord(),
      file: "/tmp/never-written-user-auth.json",
    });
    const ctor = makeFakeCtor();
    const ch = new ControlChannel({
      auth,
      handle: handler,
      hubPublicKey: publicKey,
      webSocketCtor: ctor as unknown as typeof import("ws").default,
    });
    await ch.start();
    const frame = signFrame(
      { id: "f1", type: CONTROL_FRAME_TYPES.PING, ts: Date.now() },
      privateKey,
    );
    FakeWebSocket.instances[0].emit("message", Buffer.from(JSON.stringify(frame)));
    // Allow the async handler microtask to flush.
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledOnce();
    await ch.stop();
  });

  it("rejects frames with no signature when a Hub key is configured", async () => {
    const { publicKey } = generateKeypair();
    const handler = vi.fn(async () => ({ ok: true }));
    const auth = new UserAuthManager({
      record: makeAuthRecord(),
      file: "/tmp/never-written-user-auth.json",
    });
    const ctor = makeFakeCtor();
    const ch = new ControlChannel({
      auth,
      handle: handler,
      hubPublicKey: publicKey,
      webSocketCtor: ctor as unknown as typeof import("ws").default,
    });
    await ch.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ id: "f1", type: "ping", ts: Date.now() })),
    );
    await new Promise((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
    const acks = ws.sent.map((s) => JSON.parse(s));
    expect(acks[0].ok).toBe(false);
    expect(acks[0].error.code).toBe("unsigned");
    await ch.stop();
  });

  it("rejects frames whose signature does not verify", async () => {
    const wrongKey = generateKeypair();
    const otherKey = generateKeypair();
    const handler = vi.fn(async () => ({ ok: true }));
    const auth = new UserAuthManager({
      record: makeAuthRecord(),
      file: "/tmp/never-written-user-auth.json",
    });
    const ctor = makeFakeCtor();
    const ch = new ControlChannel({
      auth,
      handle: handler,
      // Daemon trusts otherKey.publicKey; Hub signs with wrongKey.privateKey.
      hubPublicKey: otherKey.publicKey,
      webSocketCtor: ctor as unknown as typeof import("ws").default,
    });
    await ch.start();
    const frame = signFrame(
      { id: "f2", type: CONTROL_FRAME_TYPES.PING, ts: Date.now() },
      wrongKey.privateKey,
    );
    const ws = FakeWebSocket.instances[0];
    ws.emit("message", Buffer.from(JSON.stringify(frame)));
    await new Promise((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
    const acks = ws.sent.map((s) => JSON.parse(s));
    expect(acks[0].ok).toBe(false);
    expect(acks[0].error.code).toBe("bad_signature");
    await ch.stop();
  });

  it("dispatches unsigned frames when no Hub key is configured (P1 dev mode)", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const auth = new UserAuthManager({
      record: makeAuthRecord(),
      file: "/tmp/never-written-user-auth.json",
    });
    const ctor = makeFakeCtor();
    const ch = new ControlChannel({
      auth,
      handle: handler,
      hubPublicKey: null,
      webSocketCtor: ctor as unknown as typeof import("ws").default,
    });
    await ch.start();
    FakeWebSocket.instances[0].emit(
      "message",
      Buffer.from(JSON.stringify({ id: "f1", type: "ping", ts: Date.now() })),
    );
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledOnce();
    await ch.stop();
  });
});

describe("ControlChannel — REVOKE frame (plan §6.3)", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
  });

  it("acks revoke, writes auth-expired flag, and stops reconnecting without invoking the user handler", async () => {
    const writeSpy = vi.spyOn(userAuthModule, "writeAuthExpiredFlag").mockImplementation(() => {});

    const handler = vi.fn(async () => ({ ok: true }));
    const auth = new UserAuthManager({
      record: makeAuthRecord(),
      file: "/tmp/never-written-user-auth.json",
    });
    const ctor = makeFakeCtor();
    const ch = new ControlChannel({
      auth,
      handle: handler,
      hubPublicKey: null,
      webSocketCtor: ctor as unknown as typeof import("ws").default,
    });
    await ch.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "rv1",
          type: "revoke",
          ts: Date.now(),
          params: { reason: "test" },
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    expect(writeSpy).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    const acks = ws.sent.map((s) => JSON.parse(s));
    expect(acks[0]).toEqual({ id: "rv1", ok: true, result: { acknowledged: true } });
    // Channel should self-stop and refuse further connects.
    expect(ch.isConnected).toBe(false);

    writeSpy.mockRestore();
  });
});

afterEach(() => {
  FakeWebSocket.instances.length = 0;
});
