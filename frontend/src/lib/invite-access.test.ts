import { describe, expect, it } from "vitest";
import { resolveInviteAccess } from "@/lib/invite-access";

describe("resolveInviteAccess", () => {
  it("keeps guests on the invite page", () => {
    expect(
      resolveInviteAccess({
        betaGateEnabled: true,
        hasSession: false,
        sessionBetaAccess: false,
        profileBetaAccess: false,
      }),
    ).toEqual({
      pageState: "guest",
      shouldRedirectToChats: false,
      shouldRefreshSession: false,
    });
  });

  it("redirects when backend profile already has beta access even if JWT metadata is stale", () => {
    expect(
      resolveInviteAccess({
        betaGateEnabled: true,
        hasSession: true,
        sessionBetaAccess: false,
        profileBetaAccess: true,
      }),
    ).toEqual({
      pageState: "activated",
      shouldRedirectToChats: true,
      shouldRefreshSession: true,
    });
  });

  it("redirects authenticated users when beta gate is disabled", () => {
    expect(
      resolveInviteAccess({
        betaGateEnabled: false,
        hasSession: true,
        sessionBetaAccess: false,
        profileBetaAccess: false,
      }),
    ).toEqual({
      pageState: "activated",
      shouldRedirectToChats: true,
      shouldRefreshSession: false,
    });
  });
});
