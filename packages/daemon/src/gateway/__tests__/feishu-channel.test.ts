import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeishuChannel } from "../channels/feishu.js";
import type {
  ChannelStartContext,
  GatewayInboundEnvelope,
  GatewayLogger,
} from "../types.js";

const larkMock = vi.hoisted(() => ({
  requests: [] as unknown[],
  responses: [] as unknown[],
  handlers: {} as Record<string, (data: unknown) => unknown>,
  wsStartError: null as Error | null,
  wsClosed: false,
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuild: "SelfBuild" },
  Domain: { Feishu: "feishu", Lark: "lark" },
  LoggerLevel: { info: "info" },
  Client: vi.fn().mockImplementation(function Client() {
    return {
    request: vi.fn(async (args: unknown) => {
      larkMock.requests.push(args);
      const next = larkMock.responses.shift();
      if (next instanceof Error) throw next;
      return next ?? { code: 0, data: {} };
    }),
    };
  }),
  EventDispatcher: vi.fn().mockImplementation(function EventDispatcher() {
    return {
      register: vi.fn((handlers: Record<string, (data: unknown) => unknown>) => {
        Object.assign(larkMock.handlers, handlers);
      }),
    };
  }),
  WSClient: vi.fn().mockImplementation(function WSClient() {
    return {
      start: vi.fn(() => {
      if (larkMock.wsStartError) return Promise.reject(larkMock.wsStartError);
      return Promise.resolve();
      }),
      close: vi.fn(() => {
        larkMock.wsClosed = true;
      }),
    };
  }),
}));

const SILENT_LOG: GatewayLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const stubConfig = {
  channels: [],
  defaultRoute: { runtime: "claude-code", cwd: "/tmp" },
};

function makeStartCtx(abort: AbortController): {
  ctx: ChannelStartContext;
  envelopes: GatewayInboundEnvelope[];
  statuses: Array<Record<string, unknown>>;
} {
  const envelopes: GatewayInboundEnvelope[] = [];
  const statuses: Array<Record<string, unknown>> = [];
  return {
    envelopes,
    statuses,
    ctx: {
      config: stubConfig,
      accountId: "ag_self",
      abortSignal: abort.signal,
      log: SILENT_LOG,
      emit: async (env) => {
        envelopes.push(env);
      },
      setStatus: (patch) => {
        statuses.push({ ...patch });
      },
    },
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "feishu-channel-"));
  larkMock.requests = [];
  larkMock.responses = [];
  larkMock.handlers = {};
  larkMock.wsStartError = null;
  larkMock.wsClosed = false;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createFeishuChannel", () => {
  it("normalizes non-text events and deduplicates repeated message ids", async () => {
    larkMock.responses.push({
      code: 0,
      data: { pingBotInfo: { botID: "ou_bot", botName: "Bot" } },
    });
    const adapter = createFeishuChannel({
      id: "gw_fs",
      accountId: "ag_self",
      appId: "cli_a",
      appSecret: "sec",
      allowedSenderIds: ["ou_alice"],
      allowedChatIds: ["oc_chat"],
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
    });
    const abort = new AbortController();
    const { ctx, envelopes } = makeStartCtx(abort);
    const started = adapter.start(ctx);
    await vi.waitUntil(() => typeof larkMock.handlers["im.message.receive_v1"] === "function");

    const event = {
      sender: { sender_id: { open_id: "ou_alice" } },
      message: {
        message_id: "om_img_1",
        chat_id: "oc_chat",
        chat_type: "group",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v2_x" }),
      },
    };
    await larkMock.handlers["im.message.receive_v1"]!(event);
    await larkMock.handlers["im.message.receive_v1"]!(event);
    abort.abort();
    await started;

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.message.text).toBe("[image: img_v2_x]");
    expect(envelopes[0]!.message.conversation.id).toBe("feishu:chat:oc_chat");
  });

  it("sends text replies through Feishu reply API with thread mode", async () => {
    larkMock.responses.push({ code: 0, data: { message_id: "om_reply_1" } });
    const adapter = createFeishuChannel({
      id: "gw_fs",
      accountId: "ag_self",
      appId: "cli_a",
      appSecret: "sec",
    });

    const result = await adapter.send({
      log: SILENT_LOG,
      message: {
        channel: "gw_fs",
        accountId: "ag_self",
        conversationId: "feishu:chat:oc_chat",
        threadId: "om_root",
        replyTo: "om_parent",
        text: "hello",
      },
    });

    expect(result.providerMessageId).toBe("om_reply_1");
    expect(larkMock.requests).toHaveLength(1);
    const req = larkMock.requests[0] as { url: string; data: Record<string, unknown> };
    expect(req.url).toBe("/open-apis/im/v1/messages/om_parent/reply");
    expect(req.data.reply_in_thread).toBe(true);
    expect(req.data.msg_type).toBe("text");
  });

  it("uploads image attachments and sends them as Feishu image replies", async () => {
    larkMock.responses.push(
      { code: 0, data: { image_key: "img_v2_uploaded" } },
      { code: 0, data: { message_id: "om_image_reply" } },
    );
    const adapter = createFeishuChannel({
      id: "gw_fs",
      accountId: "ag_self",
      appId: "cli_a",
      appSecret: "sec",
    });

    const result = await adapter.send({
      log: SILENT_LOG,
      message: {
        channel: "gw_fs",
        accountId: "ag_self",
        conversationId: "feishu:chat:oc_chat",
        text: "",
        replyTo: "om_parent",
        attachments: [
          {
            data: new Uint8Array([1, 2, 3]),
            filename: "shot.png",
            contentType: "image/png",
          },
        ],
      },
    });

    expect(result.providerMessageId).toBe("om_image_reply");
    expect(larkMock.requests).toHaveLength(2);
    const upload = larkMock.requests[0] as { url: string; data: Record<string, unknown> };
    expect(upload.url).toBe("/open-apis/im/v1/images");
    expect(upload.data.image_type).toBe("message");
    const send = larkMock.requests[1] as { url: string; data: Record<string, unknown> };
    expect(send.url).toBe("/open-apis/im/v1/messages/om_parent/reply");
    expect(send.data.msg_type).toBe("image");
    expect(JSON.parse(send.data.content as string)).toEqual({ image_key: "img_v2_uploaded" });
  });

  it("uploads file attachments and sends them as Feishu file messages", async () => {
    larkMock.responses.push(
      { code: 0, data: { file_key: "file_v2_uploaded" } },
      { code: 0, data: { message_id: "om_file_msg" } },
    );
    const adapter = createFeishuChannel({
      id: "gw_fs",
      accountId: "ag_self",
      appId: "cli_a",
      appSecret: "sec",
    });

    const result = await adapter.send({
      log: SILENT_LOG,
      message: {
        channel: "gw_fs",
        accountId: "ag_self",
        conversationId: "feishu:chat:oc_chat",
        text: "",
        attachments: [
          {
            data: new Uint8Array([4, 5, 6]),
            filename: "report.pdf",
            contentType: "application/pdf",
          },
        ],
      },
    });

    expect(result.providerMessageId).toBe("om_file_msg");
    expect(larkMock.requests).toHaveLength(2);
    const upload = larkMock.requests[0] as { url: string; data: Record<string, unknown> };
    expect(upload.url).toBe("/open-apis/im/v1/files");
    expect(upload.data.file_type).toBe("pdf");
    expect(upload.data.file_name).toBe("report.pdf");
    const send = larkMock.requests[1] as { url: string; data: Record<string, unknown> };
    expect(send.url).toBe("/open-apis/im/v1/messages");
    expect(send.data.msg_type).toBe("file");
    expect(JSON.parse(send.data.content as string)).toEqual({ file_key: "file_v2_uploaded" });
  });

  it("exposes typing as a safe no-op because Feishu has no bot typing API", async () => {
    const debug = vi.fn();
    const adapter = createFeishuChannel({
      id: "gw_fs",
      accountId: "ag_self",
      appId: "cli_a",
      appSecret: "sec",
    });

    await adapter.typing?.({
      traceId: "feishu:om_1",
      accountId: "ag_self",
      conversationId: "feishu:chat:oc_chat",
      log: { ...SILENT_LOG, debug },
    });

    expect(larkMock.requests).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(
      "feishu typing ignored: no native bot typing API",
      expect.objectContaining({ channel: "gw_fs" }),
    );
  });

  it("surfaces websocket start failures in channel status", async () => {
    larkMock.responses.push({
      code: 0,
      data: { pingBotInfo: { botID: "ou_bot", botName: "Bot" } },
    });
    larkMock.wsStartError = new Error("ws denied");
    const adapter = createFeishuChannel({
      id: "gw_fs",
      accountId: "ag_self",
      appId: "cli_a",
      appSecret: "sec",
      allowedSenderIds: ["ou_alice"],
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
    });
    const abort = new AbortController();
    const { ctx, statuses } = makeStartCtx(abort);
    const started = adapter.start(ctx);
    await vi.waitUntil(() => statuses.some((s) => s.lastError === "ws denied"));
    abort.abort();
    await started;

    expect(adapter.status()?.lastError).toBe("ws denied");
    expect(adapter.status()?.authorized).toBe(false);
  });
});
