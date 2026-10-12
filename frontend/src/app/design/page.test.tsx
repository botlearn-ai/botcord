import { afterEach, expect, it, vi } from "vitest";
import DesignPage from "./page";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("./DesignGallery", () => ({ default: () => null }));

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "production"])("hides the gallery in production with VERCEL_ENV=%s", (env) => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", env);
  expect(() => DesignPage()).toThrow("NOT_FOUND");
});

it.each([["development", undefined], ["production", "preview"]])("allows %s / %s", (mode, env) => {
  vi.stubEnv("NODE_ENV", mode);
  vi.stubEnv("VERCEL_ENV", env);
  expect(DesignPage()).toBeTruthy();
});
