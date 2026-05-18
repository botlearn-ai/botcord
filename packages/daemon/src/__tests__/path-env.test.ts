import { describe, expect, it } from "vitest";
import path from "node:path";
import { commonDaemonPathEntries, mergePathEntries } from "../path-env.js";

describe("path-env", () => {
  it("adds common user CLI locations", () => {
    expect(commonDaemonPathEntries("/Users/alice")).toEqual(
      expect.arrayContaining([
        "/Users/alice/.botcord/bin",
        "/Users/alice/.local/bin",
        "/Users/alice/.cargo/bin",
        "/Users/alice/.bun/bin",
        "/Users/alice/.pyenv/shims",
      ]),
    );
  });

  it("preserves existing PATH precedence and de-duplicates entries", () => {
    const base = ["/usr/bin", "/bin", "/Users/alice/.local/bin"].join(path.delimiter);
    const merged = mergePathEntries(base, [
      "/Users/alice/.local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
    ]);

    expect(merged.split(path.delimiter)).toEqual([
      "/usr/bin",
      "/bin",
      "/Users/alice/.local/bin",
      "/opt/homebrew/bin",
    ]);
  });
});
