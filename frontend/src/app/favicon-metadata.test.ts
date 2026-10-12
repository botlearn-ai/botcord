import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("favicon metadata", () => {
  it("uses the VI v1.0 Node·Cord favicon assets for browser tabs", () => {
    const root = process.cwd();
    const layout = readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
    const favicon = readFileSync(path.join(root, "public/favicon.svg"), "utf8");
    const faviconIco = readFileSync(path.join(root, "src/app/favicon.ico"));
    const appleIcon = readFileSync(path.join(root, "public/apple-touch-icon.png"));

    expect(layout).toContain('icons: { icon: "/favicon.svg", apple: "/apple-touch-icon.png" }');
    // Node·Cord geometry and brand colours, with a dark-scheme variant.
    expect(favicon).toContain('viewBox="0 0 48 48"');
    expect(favicon).toContain("M8.5 34 C 24 34, 24 14, 39.5 14");
    expect(favicon).toContain("#0D98A4");
    expect(favicon).toContain("prefers-color-scheme: dark");
    expect(favicon).not.toContain("#00f0ff");
    // ICO header: type 1 (icon), three PNG-encoded sizes (16/32/48).
    expect(faviconIco.readUInt16LE(2)).toBe(1);
    expect(faviconIco.readUInt16LE(4)).toBe(3);
    expect(faviconIco.indexOf(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))).toBeGreaterThan(-1);
    expect(appleIcon.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))).toBe(true);
  });
});
