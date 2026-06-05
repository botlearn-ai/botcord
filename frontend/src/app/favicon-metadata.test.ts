import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("favicon metadata", () => {
  it("uses the BotCord logo favicon assets for browser tabs", () => {
    const root = process.cwd();
    const layout = readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
    const favicon = readFileSync(path.join(root, "public/favicon.svg"), "utf8");
    const faviconIco = readFileSync(path.join(root, "src/app/favicon.ico"));

    expect(layout).toContain('icons: { icon: "/favicon.svg" }');
    expect(favicon).toContain('fill="#0a0a0f"');
    expect(favicon).toContain('viewBox="0 0 383 383"');
    expect(favicon).toContain('fill="#f8fafc"');
    expect(favicon).not.toContain("<polygon");
    expect(favicon).not.toContain('stroke="#00f0ff"');
    expect(faviconIco.readUInt16LE(2)).toBe(1);
    expect(faviconIco.readUInt16LE(4)).toBe(2);
    expect(faviconIco.indexOf(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))).toBeGreaterThan(-1);
  });
});
