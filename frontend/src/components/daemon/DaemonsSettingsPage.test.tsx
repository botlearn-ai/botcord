// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DaemonsSettingsPage from "./DaemonsSettingsPage";
const { state } = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock("@/store/useDaemonStore", () => ({ useDaemonStore: (selector: (value: typeof state) => unknown) => selector(state) }));
vi.mock("@/components/daemon/DaemonInstallCommand", () => ({ default: () => null }));
vi.mock("@/lib/api", () => ({ downloadApiFile: vi.fn() }));
vi.mock("@/lib/anime", () => ({ animateOverlayPanelEnter: vi.fn(), animateOverlayPanelExit: (_a: unknown, _b: unknown, options: { onComplete: () => void }) => { options.onComplete(); return null; }, cleanupAnime: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(state, { daemons: [{ id: "daemon-1", label: "Work laptop", status: "online", kind: "local", last_seen_at: null, runtimes: [], daemon_version: "1.0" }], loading: false, loaded: true, error: null, revokingId: null, restartingId: null, renamingId: null, renameErrors: {}, runtimeErrors: {}, diagnosticErrors: {}, diagnosticResults: {}, refresh: vi.fn().mockResolvedValue(undefined), revoke: vi.fn().mockResolvedValue(true), rename: vi.fn().mockResolvedValue(true), restartDevice: vi.fn(), refreshRuntimes: vi.fn(), collectDiagnostics: vi.fn() });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); });
async function render() { await act(async () => root.render(<DaemonsSettingsPage />)); }
function button(label: string, scope: ParentNode = host) { return [...scope.querySelectorAll("button")].find((el) => el.getAttribute("aria-label") === label || el.textContent?.trim() === label)!; }
async function click(label: string, scope: ParentNode = host) { await act(async () => button(label, scope).click()); }
it("requires confirmation and preserves the revoke request", async () => {
  await render(); await click("Revoke"); const dialog = host.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("Work laptop"); expect(state.revoke).not.toHaveBeenCalled();
  await click("Revoke", dialog); expect(state.revoke).toHaveBeenCalledWith("daemon-1");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});
it("cancels with Escape and blocks dismissal while revoking", async () => {
  await render(); await click("Revoke");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector('[role="alertdialog"]')).toBeNull(); expect(state.revoke).not.toHaveBeenCalled();
  await click("Revoke"); state.revokingId = "daemon-1"; await render();
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(button("Cancel", host.querySelector('[role="alertdialog"]')!).disabled).toBe(true);
});
it("preserves keyboard submission and cancellation of inline renaming", async () => {
  await render(); await click("Rename"); const input = host.querySelector("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New label"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(state.rename).toHaveBeenCalledWith("daemon-1", "New label");
  await click("Rename"); act(() => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector("input")).toBeNull(); expect(state.rename).toHaveBeenCalledTimes(1);
});
