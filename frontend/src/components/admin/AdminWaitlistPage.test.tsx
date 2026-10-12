// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import AdminWaitlistPage from "./AdminWaitlistPage";
const { api, confirm } = vi.hoisted(() => ({ api: { getWaitlist: vi.fn(), approveWaitlist: vi.fn(), rejectWaitlist: vi.fn() }, confirm: vi.fn() }));
vi.mock("@/lib/api", () => ({ adminBetaApi: api }));
vi.mock("@/store/useConfirmStore", () => ({ useConfirm: () => confirm }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); });
async function mount() { api.getWaitlist.mockResolvedValue({ entries: [{ id: "entry1", email: "user@example.com", status: "pending", note: "", created_at: "2026-10-12T00:00:00Z" }] }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(<AdminWaitlistPage />)); }
it("changes the existing filter API through keyboard-operable tabs", async () => { await mount(); const tab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!; expect(api.getWaitlist).toHaveBeenLastCalledWith("pending"); await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))); expect(api.getWaitlist).toHaveBeenLastCalledWith("approved"); expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("已通过"); });
it("retains rejection confirmation and the original entry id", async () => { await mount(); const reject = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("拒绝") && el.getAttribute("role") !== "tab")!; confirm.mockResolvedValueOnce(false); await act(async () => reject.click()); expect(api.rejectWaitlist).not.toHaveBeenCalled(); confirm.mockResolvedValueOnce(true); api.rejectWaitlist.mockResolvedValue({}); await act(async () => reject.click()); expect(api.rejectWaitlist).toHaveBeenCalledWith("entry1"); });
