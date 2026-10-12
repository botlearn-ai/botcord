// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import AdminCodesPage, { type AdminCodesApi } from "./AdminCodesPage";
import type { BetaInviteCode } from "@/lib/api";
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("@/lib/api", () => ({ adminBetaApi: {} }));
vi.mock("@/store/useConfirmStore", () => ({ useConfirm: () => confirm }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const row: BetaInviteCode = { id: "1", code: "KOL_TEST", label: "Test", used_count: 1, max_uses: 500, status: "active", created_by: "test", created_at: "2026-10-12T00:00:00Z", expires_at: null };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); });
async function mount(overrides: Partial<AdminCodesApi> = {}) {
  const api = { getCodes: vi.fn().mockResolvedValue({ codes: [row] }), createCode: vi.fn().mockResolvedValue(row), revokeCode: vi.fn().mockResolvedValue({ ...row, status: "revoked" }), ...overrides };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<AdminCodesPage api={api} />); }); return api;
}
function button(text: string) { return [...host.querySelectorAll("button")].find((b) => b.textContent === text)!; }
async function click(text: string) { await act(async () => { button(text).click(); }); }
function fill(input: HTMLInputElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function submit() { await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
it("creates with the existing payload and returns focus to the launcher", async () => {
  const api = await mount(); await click("创建新码");
  const fields = host.querySelectorAll("input"); expect(document.activeElement).toBe(fields[0]);
  fill(fields[0], "  Campaign  "); fill(fields[1], "dev"); await submit();
  expect(api.createCode).toHaveBeenCalledWith({ label: "Campaign", max_uses: 500, prefix: "DEV" });
  expect(host.querySelector("form")).toBeNull(); expect(document.activeElement).toBe(button("创建新码"));
  expect(api.getCodes).toHaveBeenCalledTimes(2);
});
it("retains form data and announces a failed submission", async () => {
  await mount({ createCode: vi.fn().mockRejectedValue(new Error("Server unavailable")) }); await click("创建新码");
  fill(host.querySelector("input")!, "Campaign"); await submit();
  expect(host.querySelector("input")!.value).toBe("Campaign");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Server unavailable");
  expect(button("创建").disabled).toBe(false);
});
it("blocks duplicate pending submissions and cancellation", async () => {
  let finish!: (value: BetaInviteCode) => void;
  const createCode = vi.fn(() => new Promise<BetaInviteCode>((resolve) => { finish = resolve; }));
  await mount({ createCode }); await click("创建新码"); fill(host.querySelector("input")!, "Campaign");
  await submit(); await submit(); expect(createCode).toHaveBeenCalledTimes(1); expect(button("取消").disabled).toBe(true);
  await act(async () => finish(row));
});
it("requires confirmation before revocation and refreshes after success", async () => {
  const api = await mount(); confirm.mockResolvedValueOnce(false); await click("撤销"); expect(api.revokeCode).not.toHaveBeenCalled();
  confirm.mockResolvedValueOnce(true); await click("撤销"); expect(api.revokeCode).toHaveBeenCalledWith("1"); expect(api.getCodes).toHaveBeenCalledTimes(2);
});
it("offers retry for a list failure and recovers the table", async () => {
  await mount({ getCodes: vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ codes: [row] }) });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Offline");
  await click("重试"); expect(host.querySelector("table")?.textContent).toContain("KOL_TEST");
});
