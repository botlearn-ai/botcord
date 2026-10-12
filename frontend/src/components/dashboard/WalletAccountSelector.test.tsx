// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActiveIdentity } from "@/lib/api";

const state = vi.hoisted(() => ({ human: { human_id: "hu_owner" }, ownedAgents: [{ agent_id: "ag_bot", display_name: "Helper" }] }));
vi.mock("@/store/useDashboardSessionStore", () => ({ useDashboardSessionStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("@/lib/anime", () => ({ animateIfMotion: () => null, animatePop: () => null, animeStagger: () => 0, prefersReducedMotion: () => true, cleanupAnime: () => {} }));
import WalletAccountSelector from "./WalletAccountSelector";

let root: Root;
let host: HTMLDivElement;
const onChange = vi.fn<(value: ActiveIdentity) => void>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  state.ownedAgents = [{ agent_id: "ag_bot", display_name: "Helper" }];
  onChange.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("preserves the selected identity type and id when switching accounts from the keyboard", async () => {
  await act(() => root.render(<WalletAccountSelector value={{ type: "human", id: "hu_owner" }} onChange={onChange} label="From account" />));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
  expect(trigger.getAttribute("aria-label")).toBe("From account");
  await act(() => trigger.click());
  // Let the picker finish its scheduled initial focus before keyboard navigation.
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const options = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'));
  expect(options).toHaveLength(2);
  await act(() => { options[0].focus(); options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.activeElement).toBe(options[1]);
  await act(() => options[1].click());
  expect(onChange).toHaveBeenCalledWith({ type: "agent", id: "ag_bot" });
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("omits account switching when only the human account is available", async () => {
  state.ownedAgents = [];
  await act(() => root.render(<WalletAccountSelector value={{ type: "human", id: "hu_owner" }} onChange={onChange} />));
  expect(host.querySelector("button")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
