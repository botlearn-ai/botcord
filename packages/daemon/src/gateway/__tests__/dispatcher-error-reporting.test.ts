import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Dispatcher, type RuntimeFactory } from "../dispatcher.js";
import { SessionStore } from "../session-store.js";
import type { GatewayLogger } from "../log.js";
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
import type { TranscriptRecord, TranscriptWriter } from "../transcript.js";
import type { DaemonErrorReport, ErrorReporter } from "../../error-reporting.js";

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

class CaptureTranscript implements TranscriptWriter {
  readonly enabled = true;
  readonly rootDir = "";
  readonly records: TranscriptRecord[] = [];

  write(rec: TranscriptRecord): void {
    this.records.push(rec);
  }
}

class CaptureReporter implements ErrorReporter {
  readonly reports: DaemonErrorReport[] = [];

  report(event: DaemonErrorReport): void {
    this.reports.push(event);
  }
}

class FailingReporter implements ErrorReporter {
  report(): void {
    throw new Error("reporter unavailable");
  }
}

class ErrorRuntime implements RuntimeAdapter {
  readonly id = "codex";

  async run(_opts: RuntimeRunOptions): Promise<RuntimeRunResult> {
    return {
      text: "",
      newSessionId: "sid_1",
      error: "codex failed OPENAI_API_KEY=secret-openai",
      runtimeFailure: {
        cwd: "/repo",
        command: ["codex", "--api-key", "secret-api-value", "--token", "secret-token-value", "run"],
        exit_code: 2,
        duration_ms: 1234,
        stderr_tail: "stderr Authorization: Bearer secret\nx-api-key: secret-header\n--api-key secret-cli\nsk-live-secret",
        stdout_tail: "stdout ANTHROPIC_API_KEY=secret-anthropic password: secret-password",
        error_name: "RuntimeExitError",
        error_message: "runtime failed OPENAI_API_KEY=secret-openai",
      },
    };
  }
}

function baseConfig(): GatewayConfig {
  return {
    channels: [{ id: "botcord", type: "botcord", accountId: "ag_me" }],
    defaultRoute: {
      runtime: "codex",
      cwd: "/repo",
    },
    routes: [],
  };
}

function makeMessage(partial: Partial<GatewayInboundMessage> = {}): GatewayInboundMessage {
  return {
    id: partial.id ?? "hub_msg_1",
    channel: partial.channel ?? "botcord",
    accountId: partial.accountId ?? "ag_me",
    conversation: partial.conversation ?? {
      id: "rm_oc_1",
      kind: "direct",
      threadId: "tp_1",
    },
    sender: partial.sender ?? { id: "hu_1", name: "owner", kind: "user" },
    text: partial.text ?? "run this",
    raw: partial.raw ?? {
      envelope: {
        type: "inbox_message",
        msg_id: "wire_msg_1",
      },
    },
    replyTo: partial.replyTo ?? null,
    mentioned: partial.mentioned,
    receivedAt: partial.receivedAt ?? Date.now(),
    trace: partial.trace,
  };
}

function makeEnvelope(partial: Partial<GatewayInboundMessage> = {}): GatewayInboundEnvelope {
  return { message: makeMessage(partial) };
}

describe("dispatcher error reporting", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function scaffold(args: {
    errorReporter?: ErrorReporter;
    log?: GatewayLogger;
  } = {}): Promise<{
    dispatcher: Dispatcher;
    channel: FakeChannel;
    transcript: CaptureTranscript;
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), "dispatcher-error-reporting-"));
    tempDirs.push(dir);
    const store = new SessionStore({ path: path.join(dir, "sessions.json") });
    await store.load();
    const channel = new FakeChannel();
    const transcript = new CaptureTranscript();
    const runtimeFactory: RuntimeFactory = () => new ErrorRuntime();
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels: new Map([[channel.id, channel]]),
      runtime: runtimeFactory,
      sessionStore: store,
      log: args.log ?? silentLogger(),
      transcript,
      errorReporter: args.errorReporter,
      resolveHubUrl: () => "https://hub.test",
    });
    return { dispatcher, channel, transcript };
  }

  it("reports runtime failures with sanitized details and error_ref correlation", async () => {
    const reporter = new CaptureReporter();
    const { dispatcher, channel, transcript } = await scaffold({ errorReporter: reporter });

    await dispatcher.handle(makeEnvelope());

    expect(channel.sends).toHaveLength(1);
    const outbound = channel.sends[0]!.message;
    expect(outbound.type).toBe("error");
    expect(outbound.errorRef).toMatch(/^err_[0-9a-f]{12}$/);
    expect(outbound.text).toContain(`[error_ref: ${outbound.errorRef}]`);

    expect(reporter.reports).toHaveLength(1);
    const report = reporter.reports[0]!;
    expect(report.type).toBe("runtime_failure");
    expect(report.tags?.error_ref).toBe(outbound.errorRef);
    expect(report.tags?.agent_id).toBe("ag_me");
    expect(report.tags?.room_id).toBe("rm_oc_1");
    expect(report.tags?.topic_id).toBe("tp_1");
    expect(report.tags?.turn_id).toEqual(expect.any(String));
    expect(report.tags?.runtime).toBe("codex");
    expect(report.tags?.hub_url).toBe("https://hub.test");
    expect(report.tags?.message_id).toBe("hub_msg_1");
    expect(report.tags?.control_frame_type).toBe("inbox_message");
    expect(report.tags?.control_message_id).toBe("wire_msg_1");
    expect(report.fingerprint).toEqual([
      "botcord-daemon",
      "runtime_failure",
      "codex",
      outbound.errorRef,
    ]);

    const failure = (report.context?.runtime_failure ?? {}) as Record<string, unknown>;
    expect(failure.command).toEqual(["codex", "--api-key", "[REDACTED]", "--token", "[REDACTED]", "run"]);
    expect(failure.stderr_tail).toContain("Authorization: Bearer [REDACTED]");
    expect(failure.stderr_tail).toContain("x-api-key: [REDACTED]");
    expect(failure.stderr_tail).toContain("--api-key [REDACTED]");
    expect(failure.stderr_tail).toContain("sk-[REDACTED]");
    expect(failure.stdout_tail).toContain("ANTHROPIC_API_KEY=[REDACTED]");
    expect(failure.stdout_tail).toContain("password: [REDACTED]");
    expect(failure.error_message).toBe("runtime failed OPENAI_API_KEY=[REDACTED]");
    expect(JSON.stringify(report)).not.toContain("secret-openai");
    expect(JSON.stringify(report)).not.toContain("secret-api-value");
    expect(JSON.stringify(report)).not.toContain("secret-token-value");
    expect(JSON.stringify(report)).not.toContain("secret-header");
    expect(JSON.stringify(report)).not.toContain("secret-cli");
    expect(JSON.stringify(report)).not.toContain("secret-anthropic");
    expect(JSON.stringify(report)).not.toContain("secret-password");
    expect(JSON.stringify(report)).not.toContain("Bearer secret");

    const turnError = transcript.records.find((rec) => rec.kind === "turn_error");
    expect(turnError && "errorRef" in turnError ? turnError.errorRef : undefined)
      .toBe(outbound.errorRef);
  });

  it("suppresses reporter exceptions without breaking dispatcher error replies", async () => {
    const warnMessages: string[] = [];
    const logger: GatewayLogger = {
      info: () => {},
      warn: (msg) => warnMessages.push(msg),
      error: () => {},
      debug: () => {},
    };
    const { dispatcher, channel } = await scaffold({
      errorReporter: new FailingReporter(),
      log: logger,
    });

    await dispatcher.handle(makeEnvelope());

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]!.message.errorRef).toMatch(/^err_[0-9a-f]{12}$/);
    expect(warnMessages).toContain("daemon error reporter failed");
  });
});
