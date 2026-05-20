import { describe, expect, it } from "vitest";
import {
  CLOUD_ENV_VARS,
  isCloudMode,
  loadCloudModeConfig,
} from "../cloud-mode.js";

function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    [CLOUD_ENV_VARS.HUB_URL]: "https://api.botcord.chat",
    [CLOUD_ENV_VARS.CLOUD_DAEMON_INSTANCE_ID]: "cloud_dm_abc123def456",
    [CLOUD_ENV_VARS.DAEMON_INSTANCE_ID]: "dm_abc123def456",
    [CLOUD_ENV_VARS.ACCESS_TOKEN]: "tok_jwt_xxx",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("cloud-mode detection", () => {
  it("returns true when BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN is set", () => {
    expect(isCloudMode(makeEnv())).toBe(true);
  });

  it("returns false when the access token is missing", () => {
    expect(isCloudMode(makeEnv({ [CLOUD_ENV_VARS.ACCESS_TOKEN]: undefined }))).toBe(false);
  });

  it("returns false when the access token is empty", () => {
    expect(isCloudMode(makeEnv({ [CLOUD_ENV_VARS.ACCESS_TOKEN]: "" }))).toBe(false);
  });

  it("treats missing other env vars as still cloud-mode (will fail at load)", () => {
    // We only flip on the token; loadCloudModeConfig is what hard-fails. This
    // keeps the detection check cheap and the failure message specific.
    expect(
      isCloudMode(makeEnv({ [CLOUD_ENV_VARS.HUB_URL]: undefined })),
    ).toBe(true);
  });
});

describe("loadCloudModeConfig", () => {
  it("parses all four env vars into the resolved shape", () => {
    const cfg = loadCloudModeConfig(makeEnv());
    expect(cfg).toEqual({
      hubUrl: "https://api.botcord.chat",
      cloudDaemonInstanceId: "cloud_dm_abc123def456",
      daemonInstanceId: "dm_abc123def456",
      accessToken: "tok_jwt_xxx",
    });
  });

  it.each(Object.values(CLOUD_ENV_VARS))(
    "throws when %s is missing",
    (name) => {
      expect(() => loadCloudModeConfig(makeEnv({ [name]: undefined }))).toThrow(
        new RegExp(`required env var "${name}"`),
      );
    },
  );

  it("throws when an env var is set to an empty string", () => {
    expect(() =>
      loadCloudModeConfig(makeEnv({ [CLOUD_ENV_VARS.HUB_URL]: "" })),
    ).toThrow(/required env var "BOTCORD_HUB_URL"/);
  });
});
