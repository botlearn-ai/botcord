// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_VISIBLE_TOASTS, TOAST_EXIT_MS, useToastStore } from "@/store/useToastStore";
import Toaster, { toast } from "./Toast";

vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Toaster />));
  return { host, root };
}

const live = () => useToastStore.getState().toasts.filter((t) => !t.leaving);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  act(() => useToastStore.setState({ toasts: [] }));
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

it("adds a toast, renders it as status, and auto-dismisses after durationMs", () => {
  const { host, root } = mount();
  act(() => { toast({ title: "Copied", tone: "success" }); });
  const status = host.querySelector('[role="status"]')!;
  expect(status.textContent).toContain("Copied");
  expect(status.getAttribute("data-state")).toBe("open");

  act(() => { vi.advanceTimersByTime(3999); });
  expect(live()).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(1); });
  expect(host.querySelector('[role="status"]')?.getAttribute("data-state")).toBe("closed");
  act(() => { vi.advanceTimersByTime(TOAST_EXIT_MS); });
  expect(useToastStore.getState().toasts).toHaveLength(0);
  expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => root.unmount());
});

it("uses role=alert for danger and can be closed manually", () => {
  const { host, root } = mount();
  act(() => { toast({ title: "Failed", tone: "danger", durationMs: 0 }); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Failed");
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
  act(() => { vi.advanceTimersByTime(TOAST_EXIT_MS); });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  act(() => root.unmount());
});

it("keeps at most 3 toasts, dropping the oldest", () => {
  const { host, root } = mount();
  act(() => {
    for (const title of ["one", "two", "three", "four"]) toast({ title });
  });
  expect(live().map((t) => t.title)).toEqual(["two", "three", "four"]);
  expect(MAX_VISIBLE_TOASTS).toBe(3);
  act(() => { vi.advanceTimersByTime(TOAST_EXIT_MS); });
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(3);
  expect(host.textContent).not.toContain("one");
  act(() => root.unmount());
});

it("runs the action and dismisses", () => {
  const onClick = vi.fn();
  const { host, root } = mount();
  act(() => { toast({ title: "Archived", action: { label: "Undo", onClick } }); });
  const undo = [...host.querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
  act(() => undo.click());
  expect(onClick).toHaveBeenCalledOnce();
  expect(live()).toHaveLength(0);
  act(() => root.unmount());
});
