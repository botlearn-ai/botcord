import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultGatewaySecretPath,
  loadGatewaySecret,
  saveGatewaySecret,
  deleteGatewaySecret,
} from "../gateway/channels/secret-store.js";

describe("secret-store", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "botcord-secret-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("derives the default path under ~/.botcord/daemon/gateways when no override is given", () => {
    const file = defaultGatewaySecretPath("gw_abc");
    expect(file.endsWith(path.join(".botcord", "daemon", "gateways", "gw_abc.json"))).toBe(true);
  });

  it("honors an explicit override path", () => {
    const override = path.join(tmp, "custom.json");
    expect(defaultGatewaySecretPath("gw_abc", override)).toBe(override);
  });

  it("writes the secret with mode 0600 in a 0700 directory and round-trips the payload", () => {
    const override = path.join(tmp, "gw1", "secret.json");
    const written = saveGatewaySecret("gw1", { botToken: "tok-123" }, override);
    expect(written).toBe(override);
    expect(existsSync(override)).toBe(true);
    const fileMode = statSync(override).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = statSync(path.dirname(override)).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const loaded = loadGatewaySecret<{ botToken: string }>("gw1", override);
    expect(loaded).toEqual({ botToken: "tok-123" });
  });

  it("returns null when the secret file does not exist", () => {
    const override = path.join(tmp, "missing.json");
    expect(loadGatewaySecret("gw1", override)).toBeNull();
  });

  it("deleteGatewaySecret removes the file and is idempotent", () => {
    const override = path.join(tmp, "gw1.json");
    saveGatewaySecret("gw1", { botToken: "x" }, override);
    expect(existsSync(override)).toBe(true);
    deleteGatewaySecret("gw1", override);
    expect(existsSync(override)).toBe(false);
    // Second call must not throw.
    deleteGatewaySecret("gw1", override);
  });
});
