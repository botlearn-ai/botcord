import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve(import.meta.dirname, "../..");

describe("plugin manifest metadata", () => {
  it("keeps package and openclaw manifest versions in sync", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(pluginRoot, "package.json"), "utf8"),
    ) as { version: string };
    const manifestJson = JSON.parse(
      readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
    ) as { version: string; skills?: string[] };

    expect(manifestJson.version).toBe(packageJson.version);
    expect(manifestJson.skills).toContain("./skills");
  });
});
