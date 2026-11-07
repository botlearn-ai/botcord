import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAuthRedirectUrl,
  getServerHubBaseUrl,
  getServerSupabaseUrl,
  getSupabaseAuthCookieName,
  shouldEnableVercelAnalytics,
} from "./server-endpoints";

describe("server service endpoints", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the private Hub URL without changing the public URL variable", () => {
    vi.stubEnv("HUB_INTERNAL_URL", "http://botcord-backend:8000");
    vi.stubEnv("NEXT_PUBLIC_HUB_BASE_URL", "https://api.example.test");

    expect(getServerHubBaseUrl()).toBe("http://botcord-backend:8000");
    expect(process.env.NEXT_PUBLIC_HUB_BASE_URL).toBe("https://api.example.test");
  });

  it("keeps the existing Hub fallback order when no private URL is configured", () => {
    vi.stubEnv("HUB_INTERNAL_URL", "");
    vi.stubEnv("NEXT_PUBLIC_HUB_BASE_URL", "https://api.example.test");

    expect(getServerHubBaseUrl()).toBe("https://api.example.test");
  });

  it("uses the private Supabase URL but derives cookies from the public URL", () => {
    vi.stubEnv("SUPABASE_INTERNAL_URL", "http://supabase-kong:8000");
    const publicUrl = "https://auth.example.test";

    expect(getServerSupabaseUrl(publicUrl)).toBe("http://supabase-kong:8000");
    expect(getSupabaseAuthCookieName(publicUrl)).toBe("sb-auth-auth-token");
  });

  it("matches the Supabase SDK cookie namespace for local and hosted URLs", () => {
    vi.stubEnv("SUPABASE_INTERNAL_URL", "");

    expect(getServerSupabaseUrl("http://localhost:54321")).toBe("http://localhost:54321");
    expect(getSupabaseAuthCookieName("http://localhost:54321")).toBe(
      "sb-localhost-auth-token",
    );
    expect(getSupabaseAuthCookieName("https://project.supabase.co")).toBe(
      "sb-project-auth-token",
    );
  });

  it("uses the configured public app origin instead of the container request origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.test.botcord.chat");

    expect(
      getAuthRedirectUrl(
        "http://0.0.0.0:3000/auth/callback?code=test",
        "/chats/home?from=callback",
      ).toString(),
    ).toBe("https://www.test.botcord.chat/chats/home?from=callback");
  });

  it("falls back to the request origin when no public app URL is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    expect(
      getAuthRedirectUrl(
        "http://localhost:3000/auth/callback?code=test",
        "/chats/home",
      ).toString(),
    ).toBe("http://localhost:3000/chats/home");
  });

  it.each([
    "https://evil.example/steal",
    "//evil.example/steal",
    "/\\evil.example/steal",
    "chats/home",
  ])("rejects unsafe auth callback next target %s", (next) => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.test.botcord.chat");

    expect(
      getAuthRedirectUrl(
        "http://0.0.0.0:3000/auth/callback?code=test",
        next,
      ).toString(),
    ).toBe("https://www.test.botcord.chat/chats/home");
  });

  it("enables Vercel Analytics only in an actual Vercel runtime", () => {
    vi.stubEnv("VERCEL", "1");
    expect(shouldEnableVercelAnalytics()).toBe(true);

    vi.stubEnv("VERCEL", "");
    expect(shouldEnableVercelAnalytics()).toBe(false);
  });
});
