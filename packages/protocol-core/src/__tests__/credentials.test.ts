import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadStoredCredentials, normalizeTokenExpiresAt } from "../credentials.js";

describe("credentials token expiry", () => {
  it("normalizes millisecond timestamps to seconds", () => {
    expect(normalizeTokenExpiresAt(1_779_856_985_546)).toBe(1_779_856_985);
  });

  it("preserves second timestamps", () => {
    expect(normalizeTokenExpiresAt(1_779_856_985)).toBe(1_779_856_985);
  });

  it("normalizes legacy millisecond tokenExpiresAt values when loading credentials", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "protocol-creds-"));
    const file = path.join(tmp, "ag_test.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          hubUrl: "https://hub.example",
          agentId: "ag_test",
          keyId: "k_test",
          privateKey: Buffer.alloc(32, 1).toString("base64"),
          token: "old-token",
          tokenExpiresAt: 1_779_856_985_546,
        }),
      );

      expect(loadStoredCredentials(file).tokenExpiresAt).toBe(1_779_856_985);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
