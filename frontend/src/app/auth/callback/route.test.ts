import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("auth callback redirects", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects callback failures to the configured public app origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.test.botcord.chat");

    const response = await GET(
      new Request("http://0.0.0.0:3000/auth/callback"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.test.botcord.chat/login?error=auth_callback_failed",
    );
  });
});
