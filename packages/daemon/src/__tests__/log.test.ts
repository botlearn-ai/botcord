import { describe, expect, it } from "vitest";
import { formatLogLine } from "../log.js";

describe("formatLogLine", () => {
  it("renders compact text with level, message, details, and trailing timestamp", () => {
    const line = formatLogLine(
      "warn",
      "botcord ws error",
      { err: "Error: Unexpected server response: 503" },
      new Date("2026-05-01T00:22:07.131Z"),
    );

    expect(line).toBe(
      '[WARN] botcord ws error err="Error: Unexpected server response: 503" ts=2026-05-01T00:22:07.131Z',
    );
  });

  it("keeps object details readable without replacing the primary message", () => {
    const line = formatLogLine(
      "info",
      "botcord ws server error",
      { msg: { type: "error", code: 503 } },
      new Date("2026-05-01T00:22:07.131Z"),
    );

    expect(line).toBe(
      '[INFO] botcord ws server error msg={"type":"error","code":503} ts=2026-05-01T00:22:07.131Z',
    );
  });
});
