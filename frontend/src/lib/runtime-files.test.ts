import { describe, expect, it } from "vitest";
import {
  mergeRuntimeFileContentResult,
  runtimeFileNeedsContentLoad,
  type RuntimeFilePreviewEntry,
} from "./runtime-files";

describe("runtime file preview helpers", () => {
  it("treats metadata entries with null content as unloaded", () => {
    expect(runtimeFileNeedsContentLoad({ id: "memory:working-memory.json", content: null })).toBe(
      true,
    );
  });

  it("does not load entries that already have content, errors, truncation, or active loading", () => {
    expect(runtimeFileNeedsContentLoad({ id: "file", content: "" })).toBe(false);
    expect(runtimeFileNeedsContentLoad({ id: "file", error: "missing" })).toBe(false);
    expect(runtimeFileNeedsContentLoad({ id: "file", truncated: true })).toBe(false);
    expect(runtimeFileNeedsContentLoad({ id: "file" }, "file")).toBe(false);
  });

  it("merges lazy-loaded content into the selected metadata entry", () => {
    const files: RuntimeFilePreviewEntry[] = [{ id: "workspace:task.md", content: null }];

    expect(
      mergeRuntimeFileContentResult(
        files,
        "workspace:task.md",
        { id: "workspace:task.md", content: "loaded" },
        "Failed to load files",
      ),
    ).toEqual([{ id: "workspace:task.md", content: "loaded", error: undefined }]);
  });

  it("marks a stale selected file as non-retryable when the daemon returns no file", () => {
    const files: RuntimeFilePreviewEntry[] = [{ id: "workspace:deleted.md", content: null }];

    const next = mergeRuntimeFileContentResult(
      files,
      "workspace:deleted.md",
      null,
      "Failed to load files",
    );

    expect(next).toEqual([
      { id: "workspace:deleted.md", content: null, error: "Failed to load files" },
    ]);
    expect(runtimeFileNeedsContentLoad(next[0])).toBe(false);
  });
});
