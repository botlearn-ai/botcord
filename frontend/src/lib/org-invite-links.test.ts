import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInviteLinkInput,
  copyText,
  inviteLinkUrl,
  inviteRowStatus,
  inviteUnavailableReason,
  inviteUsageLabel,
} from "./org-invite-links";

describe("org invite link helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps the expiry and usage choices to the API body", () => {
    // Personal by default: one person, the chosen expiry, optional label.
    expect(buildInviteLinkInput("7", false)).toEqual({ expires_in_days: 7, max_uses: 1 });
    expect(buildInviteLinkInput("7", false, "  Alice ")).toEqual({ expires_in_days: 7, max_uses: 1, label: "Alice" });
    expect(buildInviteLinkInput("never", true)).toEqual({ expires_in_days: null, max_uses: null });
  });
  it("builds the full link from the current origin and server path", () => {
    expect(inviteLinkUrl("https://botcord.chat/", { path: "/join/abc", code: "abc" })).toBe(
      "https://botcord.chat/join/abc",
    );
    expect(inviteLinkUrl("https://botcord.chat", { path: "", code: "x y" })).toBe(
      "https://botcord.chat/join/x%20y",
    );
  });
  it("copies with the clipboard API and reports failure for the selection fallback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("https://x/join/a")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://x/join/a");
    writeText.mockRejectedValueOnce(new Error("denied"));
    await expect(copyText("y")).resolves.toBe(false);
    vi.stubGlobal("navigator", {});
    await expect(copyText("z")).resolves.toBe(false);
  });
  it("describes usage and unavailable reasons", () => {
    expect(inviteUsageLabel({ use_count: 2, max_uses: 5 }, true)).toBe("已使用 2/5");
    expect(inviteUsageLabel({ use_count: 3, max_uses: null }, false)).toBe("3 used · unlimited");
    expect(inviteUnavailableReason("exhausted", true)).toContain("使用次数上限");
    expect(inviteUnavailableReason("exhausted", true, true)).toContain("专属邀请，已经被使用过了");
    expect(inviteUnavailableReason("unavailable", false)).toContain("organization is currently unavailable");
  });
});

describe("inviteRowStatus", () => {
  it("shows who joined through a used personal invite", () => {
    expect(inviteRowStatus({ status: "exhausted", max_uses: 1, redeemed_by_name: "nina" }, true)).toBe("已加入：nina");
    expect(inviteRowStatus({ status: "active", max_uses: 1, redeemed_by_name: null }, true)).toBe("待接受");
    expect(inviteRowStatus({ status: "active", max_uses: null, redeemed_by_name: null }, false)).toBe("Active");
  });
});
