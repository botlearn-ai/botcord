import { describe, expect, it } from "vitest";
import { resolveStartAuthAction } from "../start-auth.js";
import type { UserAuthRecord } from "../user-auth.js";

const existingAuth: UserAuthRecord = {
  version: 1,
  userId: "usr_1",
  daemonInstanceId: "dm_1",
  hubUrl: "https://hub.example",
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: Date.now() + 60_000,
  loggedInAt: new Date().toISOString(),
};

describe("resolveStartAuthAction", () => {
  it("redeems an install token even when existing auth is available", () => {
    expect(
      resolveStartAuthAction({
        existing: existingAuth,
        relogin: false,
        installToken: "dit_expired",
      }),
    ).toBe("install-token");
  });

  it("redeems an install token when no existing auth is available", () => {
    expect(
      resolveStartAuthAction({
        existing: null,
        relogin: false,
        installToken: "dit_new",
      }),
    ).toBe("install-token");
  });

  it("allows --relogin to re-bind with an install token", () => {
    expect(
      resolveStartAuthAction({
        existing: existingAuth,
        relogin: true,
        installToken: "dit_new",
      }),
    ).toBe("install-token");
  });
});
