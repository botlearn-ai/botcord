// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useMobilePickerStyle } from "./use-mobile-picker-style";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
function Picker({ open = true }: { open?: boolean }) { return <div data-picker style={useMobilePickerStyle(open)} />; }
function mount() {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Picker />)); return host.firstElementChild as HTMLElement;
}
it("keeps the picker above the virtual keyboard and updates when it resizes", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const viewport = Object.assign(new EventTarget(), { height: 300, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerHeight", 800);
  const picker = mount();
  expect(picker.style.position).toBe("fixed");
  expect(picker.style.bottom).toContain("512px");
  expect(picker.style.maxHeight).toBe("268px");
  act(() => { viewport.height = 700; viewport.dispatchEvent(new Event("resize")); });
  expect(picker.style.bottom).toContain("112px");
  expect(picker.style.maxHeight).toBe("360px");
  act(() => root.render(<Picker open={false} />));
  expect(picker.style.position).toBe("");
});
it("keeps the anchored desktop picker layout", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  expect(mount().style.position).toBe("");
});
it("opens below the anchor, then above it, and docks to the bottom when neither fits", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerHeight", 800);
  const rect = { top: 56, bottom: 100 };
  const anchor = { current: { getBoundingClientRect: () => rect } as HTMLElement };
  function Anchored() { return <div data-picker style={useMobilePickerStyle(true, anchor)} />; }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Anchored />));
  const picker = host.firstElementChild as HTMLElement;
  expect(picker.style.top).toBe("108px");
  expect(picker.style.bottom).toBe("auto");
  expect(picker.style.maxHeight).toBe("360px");
  act(() => { rect.top = 600; rect.bottom = 644; viewport.dispatchEvent(new Event("resize")); });
  expect(picker.style.top).toBe("auto");
  expect(picker.style.bottom).toBe("208px");
  expect(picker.style.maxHeight).toBe("360px");
  act(() => { rect.top = 56; rect.bottom = 100; viewport.height = 250; viewport.dispatchEvent(new Event("resize")); });
  expect(picker.style.top).toBe("auto");
  expect(picker.style.bottom).toContain("562px");
});
