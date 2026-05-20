import { describe, expect, it } from "vitest";
import { CloudAuthManager, asUserAuthManager } from "../cloud-auth.js";
import type { CloudModeConfig } from "../cloud-mode.js";

function makeCfg(overrides: Partial<CloudModeConfig> = {}): CloudModeConfig {
  return {
    hubUrl: "https://api.botcord.chat",
    cloudDaemonInstanceId: "cloud_dm_abc",
    daemonInstanceId: "dm_abc",
    accessToken: "tok_xyz",
    ...overrides,
  };
}

describe("CloudAuthManager", () => {
  it("exposes a UserAuthRecord-shaped current property", () => {
    const mgr = new CloudAuthManager(makeCfg());
    expect(mgr.current.hubUrl).toBe("https://api.botcord.chat");
    expect(mgr.current.daemonInstanceId).toBe("dm_abc");
    expect(mgr.current.accessToken).toBe("tok_xyz");
    expect(mgr.current.refreshToken).toBe("");
    // expiresAt should be effectively infinity so the channel doesn't try to
    // refresh — provider relaunches the daemon on token rotation.
    expect(mgr.current.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("uses the cloud daemon instance id as the userId surrogate", () => {
    const mgr = new CloudAuthManager(makeCfg({ cloudDaemonInstanceId: "cloud_dm_xyz" }));
    expect(mgr.current.userId).toBe("cloud_dm_xyz");
  });

  it("ensureAccessToken returns the injected token", async () => {
    const mgr = new CloudAuthManager(makeCfg({ accessToken: "tok_42" }));
    expect(await mgr.ensureAccessToken()).toBe("tok_42");
  });

  it("asUserAuthManager casts to the UserAuthManager shape without copying", () => {
    const mgr = new CloudAuthManager(makeCfg());
    const cast = asUserAuthManager(mgr);
    expect(cast.current).toBe(mgr.current);
  });
});
