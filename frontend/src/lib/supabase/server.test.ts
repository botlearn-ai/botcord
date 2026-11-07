import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClientMock, cookiesMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(() => ({ auth: {} })),
  cookiesMock: vi.fn(async () => ({
    getAll: vi.fn(() => []),
    set: vi.fn(),
  })),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

describe("server Supabase client networking", () => {
  beforeEach(() => {
    vi.resetModules();
    createServerClientMock.mockClear();
    cookiesMock.mockClear();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://auth.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the internal API while preserving the browser cookie namespace", async () => {
    vi.stubEnv("SUPABASE_INTERNAL_URL", "http://supabase-kong:8000");
    const { createClient } = await import("./server");

    await createClient();

    expect(createServerClientMock).toHaveBeenCalledWith(
      "http://supabase-kong:8000",
      "test-anon-key",
      expect.objectContaining({
        cookieOptions: { name: "sb-auth-auth-token" },
      }),
    );
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://auth.example.test");
  });

  it("keeps the public API URL when no internal route is configured", async () => {
    vi.stubEnv("SUPABASE_INTERNAL_URL", "");
    const { createClient } = await import("./server");

    await createClient();

    expect(createServerClientMock).toHaveBeenCalledWith(
      "https://auth.example.test",
      "test-anon-key",
      expect.objectContaining({
        cookieOptions: { name: "sb-auth-auth-token" },
      }),
    );
  });
});
