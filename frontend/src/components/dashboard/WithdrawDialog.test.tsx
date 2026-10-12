// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const createWithdrawal = vi.hoisted(() => vi.fn());
vi.mock("./DashboardOverlayPortal", () => ({ withDashboardOverlayPortal: (Component: unknown) => Component }));
vi.mock("./WalletAccountSelector", () => ({ default: () => null }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("@/lib/api", () => ({ api: { createWithdrawal }, ApiError: class ApiError extends Error {} }));
vi.mock("@/store/useDashboardSessionStore", () => ({ useDashboardSessionStore: (select: (state: unknown) => unknown) => select({ human: { human_id: "human_1" }, sessionMode: "authenticated" }) }));
vi.mock("@/store/useDashboardWalletStore", () => ({ useDashboardWalletStore: (select: (state: unknown) => unknown) => select({ humanWallet: { available_balance_minor: "200000" }, botWallets: {} }) }));
vi.mock("@/lib/anime", () => ({
  animatePop: () => null, animateIfMotion: () => null, animeStagger: () => 0, cleanupAnime: () => {}, prefersReducedMotion: () => true,
  animateOverlayPanelEnter: () => null,
  animateOverlayPanelExit: (_overlay: unknown, _panel: unknown, options: { onComplete: () => void }) => { options.onComplete(); return null; },
}));
import WithdrawDialog from "./WithdrawDialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const close = vi.fn();
const success = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<WithdrawDialog onClose={close} onSuccess={success} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function input(placeholder: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
function fillBank(amount = "1000") {
  input("0.00", amount); input("Jane Doe", "Jane Doe"); input("Bank of China", "Example bank"); input("6222 8888 1234", "12345678");
}
function submit() { return act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); }); }

it("requires explicit review confirmation before native submit can create a withdrawal", async () => {
  fillBank(); await submit();
  expect(createWithdrawal).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector('label label')).toBeNull();
});
it("keeps the selected wallet and minor-unit payload, and blocks dismissal while pending", async () => {
  let resolve!: () => void;
  createWithdrawal.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
  fillBank(); act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await submit();
  expect(createWithdrawal).toHaveBeenCalledWith({ amount_minor: 100000, destination_type: "bank", destination: { account_name: "Jane Doe", bank_name: "Example bank", account_no: "12345678", contact_note: "" }, idempotency_key: expect.any(String) }, { type: "human", id: "human_1" });
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  expect(close).not.toHaveBeenCalled();
  await act(async () => resolve()); expect(success).toHaveBeenCalledOnce();
});
it("preserves entered destination after a failed request and permits retry", async () => {
  createWithdrawal.mockRejectedValueOnce(new Error("offline"));
  fillBank(); act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await submit();
  expect(host.querySelector<HTMLInputElement>('input[placeholder="6222 8888 1234"]')!.value).toBe("12345678");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(success).not.toHaveBeenCalled();
});
it("dismisses the destination picker before dismissing the wallet dialog", () => {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
  act(() => trigger.click());
  act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="listbox"]')).toBeNull(); expect(close).not.toHaveBeenCalled();
  act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(close).toHaveBeenCalledOnce();
});
