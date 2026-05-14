import { describe, expect, it } from "vitest";
import { renderRegistrationConfirmationEmail } from "@/lib/email/registration-confirmation";

describe("renderRegistrationConfirmationEmail", () => {
  it("renders BotCord confirmation copy in text and HTML forms", () => {
    const confirmUrl = "https://botcord.chat/auth/callback?code=abc123";
    const rendered = renderRegistrationConfirmationEmail(confirmUrl);

    expect(rendered.subject).toContain("确认你的 BotCord 账号");
    expect(rendered.text).toContain(confirmUrl);
    expect(rendered.text).toContain("Claude Code / Codex CLI / OpenClaw / Hermes");
    expect(rendered.html).toContain("还差一步，激活你的账号");
    expect(rendered.html).toContain(`href="${confirmUrl}"`);
  });

  it("escapes the confirmation URL in HTML output", () => {
    const rendered = renderRegistrationConfirmationEmail(
      "https://botcord.chat/auth/callback?code=<script>&next=\"x\"",
    );

    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("&quot;x&quot;");
    expect(rendered.html).not.toContain("<script>");
  });
});
