import { describe, expect, it } from "vitest";
import {
  extractUsageLimitReset,
  formatUsageLimitMessage,
  looksLikeTransientRuntimeError,
  looksLikeRuntimeAuthFailure,
  looksLikeUsageLimit,
} from "../runtime-errors.js";

// Real-world samples observed from each runtime's error output.
const CLAUDE_ABSOLUTE = "Claude usage limit reached. Your limit will reset at 2pm (America/New_York)";
const CLAUDE_APPROX =
  "You've hit your usage limit. Your limit will reset at approximately 11:00 PM Europe/Berlin time.";
const CLAUDE_PIPE = "Claude AI usage limit reached|1719345600";
const CODEX_RELATIVE = "You've reached your 5-hour message limit. Try again in 3h 42m.";
const CODEX_JSON = '{"type":"error","error":{"type":"usage_limit_reached","code":"insufficient_quota"}}';
const RATE_LIMIT = "API Error: rate_limit_exceeded — please slow down";
const COLONLESS_RATE_LIMIT = "API Error 429 rate_limit_exceeded";

describe("looksLikeRuntimeAuthFailure", () => {
  it("matches runtime API 4xx auth failures with or without the API Error colon", () => {
    expect(looksLikeRuntimeAuthFailure("API Error: 401 Invalid authentication credentials")).toBe(true);
    expect(looksLikeRuntimeAuthFailure("API Error 401 Invalid authentication credentials")).toBe(true);
    expect(looksLikeRuntimeAuthFailure("Failed to authenticate. API Error 401 Invalid authentication credentials")).toBe(true);
  });

  it("does not match non-auth runtime output", () => {
    expect(looksLikeRuntimeAuthFailure("API Error: rate_limit_exceeded — please slow down")).toBe(false);
    expect(looksLikeRuntimeAuthFailure(COLONLESS_RATE_LIMIT)).toBe(false);
    expect(looksLikeRuntimeAuthFailure("API Error 500 upstream unavailable")).toBe(false);
    expect(looksLikeRuntimeAuthFailure("ordinary model reply")).toBe(false);
  });
});

describe("looksLikeUsageLimit", () => {
  it("matches every runtime's quota-exhaustion phrasing", () => {
    expect(looksLikeUsageLimit(CLAUDE_ABSOLUTE)).toBe(true);
    expect(looksLikeUsageLimit(CLAUDE_APPROX)).toBe(true);
    expect(looksLikeUsageLimit(CLAUDE_PIPE)).toBe(true);
    expect(looksLikeUsageLimit(CODEX_RELATIVE)).toBe(true);
    expect(looksLikeUsageLimit(CODEX_JSON)).toBe(true);
    expect(looksLikeUsageLimit(RATE_LIMIT)).toBe(true);
    expect(looksLikeUsageLimit(COLONLESS_RATE_LIMIT)).toBe(true);
  });

  it("does not reclassify ordinary runtime failures", () => {
    expect(looksLikeUsageLimit("")).toBe(false);
    expect(looksLikeUsageLimit("TypeError: cannot read property 'x' of undefined")).toBe(false);
    expect(looksLikeUsageLimit("codex exited with code 1: segfault")).toBe(false);
    expect(looksLikeUsageLimit("Connection reset by peer")).toBe(false);
  });
});

describe("looksLikeTransientRuntimeError", () => {
  it("matches upstream stream disconnects surfaced by hosted runtimes", () => {
    expect(
      looksLikeTransientRuntimeError(
        "error while calling https://chatgpt.com/backend-api/: stream disconnected before completion",
      ),
    ).toBe(true);
  });

  it("does not match ordinary runtime failures", () => {
    expect(looksLikeTransientRuntimeError("missing API key")).toBe(false);
    expect(looksLikeTransientRuntimeError("unsupported command option --foo")).toBe(false);
  });
});

describe("extractUsageLimitReset", () => {
  it("lifts an absolute clock time verbatim (timezone stays in the runtime's words)", () => {
    expect(extractUsageLimitReset(CLAUDE_ABSOLUTE)).toBe("2pm (America/New_York)");
  });

  it("drops the trailing 'time' and 'approximately' filler", () => {
    expect(extractUsageLimitReset(CLAUDE_APPROX)).toBe("11:00 PM Europe/Berlin");
  });

  it("keeps a relative duration with an 'in' prefix", () => {
    expect(extractUsageLimitReset(CODEX_RELATIVE)).toBe("in 3h 42m");
    expect(extractUsageLimitReset("please try again after 5 minutes")).toBe("in 5 minutes");
  });

  it("renders the legacy epoch-pipe form as a UTC stamp", () => {
    expect(extractUsageLimitReset(CLAUDE_PIPE)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  });

  it("returns null when the runtime gave no hint", () => {
    expect(extractUsageLimitReset(CODEX_JSON)).toBeNull();
    expect(extractUsageLimitReset("")).toBeNull();
  });
});

describe("formatUsageLimitMessage", () => {
  it("composes a calm line with the reset time and runtime label", () => {
    expect(formatUsageLimitMessage(CLAUDE_ABSOLUTE, "claude-code")).toBe(
      "Claude Code usage limit reached — resets at 2pm (America/New_York).",
    );
    expect(formatUsageLimitMessage(CODEX_RELATIVE, "codex")).toBe(
      "Codex usage limit reached — resets in 3h 42m.",
    );
  });

  it("falls back gracefully when no reset time is present", () => {
    expect(formatUsageLimitMessage(CODEX_JSON, "codex")).toBe(
      "Codex usage limit reached — please try again later.",
    );
  });

  it("uses a neutral label for unknown runtimes", () => {
    expect(formatUsageLimitMessage(CODEX_JSON, undefined)).toBe(
      "Agent runtime usage limit reached — please try again later.",
    );
  });
});
