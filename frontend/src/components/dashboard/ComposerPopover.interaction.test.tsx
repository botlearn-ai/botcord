// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import ComposerPopover from "./ComposerPopover";

it("repositions above an unchanged anchor when the keyboard resizes its ancestor", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const observers: { callback: () => void; nodes: Element[] }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    entry: { callback: () => void; nodes: Element[] };
    constructor(callback: () => void) { this.entry = { callback, nodes: [] }; observers.push(this.entry); }
    observe(node: Element) { this.entry.nodes.push(node); }
    disconnect() {}
  });
  const host = document.createElement("div");
  const ancestor = document.createElement("div");
  const anchor = document.createElement("div");
  ancestor.append(anchor);
  document.body.append(host, ancestor);
  const ref = createRef<HTMLElement>();
  ref.current = anchor;
  let top = 700;
  anchor.getBoundingClientRect = () => ({ left: 8, top, width: 360, height: 44 } as DOMRect);
  const root = createRoot(host);
  try {
    await act(() => root.render(<ComposerPopover anchorRef={ref} onClose={() => {}} matchWidth><span>candidate</span></ComposerPopover>));
    const panel = document.querySelector<HTMLElement>(".liquid-menu")!;
    expect(panel.style.top).toBe("692px");
    // Same anchor dimensions, new position after the chat root shrinks.
    top = 380;
    await act(() => {
      for (const observer of observers) if (observer.nodes.includes(ancestor)) observer.callback();
    });
    expect(panel.style.top).toBe("372px");
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      // VisualViewport scroll moves the root after the event listeners run.
      top = 300;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(panel.style.top).toBe("292px");
  } finally {
    await act(() => root.unmount());
    host.remove(); ancestor.remove(); vi.unstubAllGlobals();
  }
});
