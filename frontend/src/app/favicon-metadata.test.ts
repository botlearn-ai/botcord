import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("favicon metadata", () => {
  it("uses the contrast-safe favicon asset for browser tabs", () => {
    const root = process.cwd();
    const layout = readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
    const favicon = readFileSync(path.join(root, "public/favicon.svg"), "utf8");

    expect(layout).toContain('icons: { icon: "/favicon.svg" }');
    expect(favicon).toContain('fill="#0a0a0f"');
    expect(favicon).toContain('stroke="#00f0ff"');
    expect(favicon).toContain('fill="#00f0ff"');
  });
});
