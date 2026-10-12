// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useConfirmStore } from "@/store/useConfirmStore";
import type { ConfirmOptions } from "@/store/useConfirmStore";
import ConfirmDialog from "./ConfirmDialog";

// Exit motion finishes immediately so the result resolves synchronously.
vi.mock("@/lib/anime", () => ({
  animateOverlayPanelEnter: () => null,
  animateOverlayPanelExit: (_overlay: unknown, _panel: unknown, options?: { onComplete?: () => void }) => {
    options?.onComplete?.();
    return null;
  },
  cleanupAnime: () => {},
}));
vi.mock("@/lib/i18n", async (original) => ({ ...await original<object>(), useLanguage: () => "en" }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<ConfirmDialog />));
  return { host, root };
}

function request(options: ConfirmOptions) {
  let result: boolean | undefined;
  act(() => {
    useConfirmStore.getState().open({ ...options, resolve: (value) => { result = value; } });
  });
  return () => result;
}

afterEach(() => {
  act(() => useConfirmStore.setState({ current: null }));
  document.body.innerHTML = "";
});

it("renders a danger confirm as an alertdialog and resolves true on confirm", () => {
  const { root } = mount();
  const result = request({ title: "Delete this agent?", message: "This cannot be undone.", confirmLabel: "Delete", tone: "danger" });

  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Delete this agent?");
  expect(dialog?.textContent).toContain("This cannot be undone.");
  const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Delete");
  expect(confirm?.className).toContain("text-danger");

  act(() => confirm!.click());
  expect(result()).toBe(true);
  expect(useConfirmStore.getState().current).toBeNull();
  act(() => root.unmount());
});

it("resolves false when dismissed with Escape", () => {
  const { root } = mount();
  const result = request({ title: "Leave room?" });

  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(result()).toBe(false);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  act(() => root.unmount());
});
