import { describe, expect, it } from "vitest";
import { GET } from "@/app/auth/desktop-callback/route";

describe("desktop auth callback", () => {
  it("hands OAuth results back to the installed desktop app via a top-level deep link", async () => {
    const response = await GET(
      new Request("https://botcord.chat/auth/desktop-callback?code=abc123&next=%2Fchats%2Fhome"),
    );
    const html = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("botcord://auth/callback?code=abc123&next=%2Fchats%2Fhome");
    expect(html).toContain("window.location.href = target");
    expect(html).toContain('id="handoff"');
  });
});
