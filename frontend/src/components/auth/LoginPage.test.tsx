// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";
const { client, router, params } = vi.hoisted(() => ({ client: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }), signInWithPassword: vi.fn(), signInWithOAuth: vi.fn() } }, router: { push: vi.fn(), replace: vi.fn() }, params: new URLSearchParams("next=/settings/daemons") }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("next/navigation", () => ({ useSearchParams: () => params }));
vi.mock("nextjs-toploader/app", () => ({ useRouter: () => router }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("@/lib/api", () => ({ publicApiFetch: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); });
async function mount() { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(<LoginPage />)); }
function fill(id: string, value: string) { const input = host.querySelector<HTMLInputElement>(`#${id}`)!; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function submit() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
it("submits native email/password fields and retains the redirect target", async () => { client.auth.signInWithPassword.mockResolvedValue({ error: null }); await mount(); fill("email", "user@example.com"); fill("password", "secret12"); await submit(); expect(client.auth.signInWithPassword).toHaveBeenCalledWith({ email: "user@example.com", password: "secret12" }); expect(router.push).toHaveBeenCalledWith("/settings/daemons"); });
it("announces authentication failure without clearing the entered fields", async () => { client.auth.signInWithPassword.mockResolvedValue({ error: { message: "Invalid credentials" } }); await mount(); fill("email", "user@example.com"); fill("password", "secret12"); await submit(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid credentials"); expect(host.querySelector<HTMLInputElement>("#email")!.value).toBe("user@example.com"); expect(router.push).not.toHaveBeenCalled(); });
it("keeps OAuth actions out of native form submission", async () => { client.auth.signInWithOAuth.mockResolvedValue({ error: null }); await mount(); const button = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Google"))!; expect(button.type).toBe("button"); await act(async () => button.click()); expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: `${window.location.origin}/auth/callback?next=%2Fsettings%2Fdaemons` } }); expect(client.auth.signInWithPassword).not.toHaveBeenCalled(); });
