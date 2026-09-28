// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MessageComposer from "./MessageComposer";

vi.mock("@/lib/anime", () => ({
  animateIfMotion: () => null, animeStagger: () => 0, cleanupAnime: () => {},
}));

let root: Root;
let host: HTMLDivElement;
const onSend = vi.fn();
const input = () => host.querySelector("textarea")!;
const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
const click = async (element: HTMLElement) => act(() => element.click());
const key = async (value: string, isComposing = false) => act(() => {
  input().dispatchEvent(new KeyboardEvent("keydown", { key: value, isComposing, bubbles: true, cancelable: true }));
  input().dispatchEvent(new KeyboardEvent("keyup", { key: value, isComposing, bubbles: true }));
});

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  onSend.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<MessageComposer onSend={onSend} mentionCandidates={[
    { agent_id: "hu_alice", display_name: "Alice", id: "hu_alice" },
    { agent_id: "ag_helper", display_name: "Helper", id: "ag_helper" },
  ]} />));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("composer interaction", () => {
  it("opens mentions from the shortcut, inserts a choice, and sends its identity", async () => {
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Mention someone"]')!);
    expect(input().value).toBe("@");
    expect(options()).toHaveLength(2);
    expect(input().getAttribute("aria-controls")).toBe(document.querySelector('[role="listbox"]')?.id);
    await click(options()[0]);
    expect(input().value).toBe("@Alice ");
    expect(host.querySelector('[aria-hidden="true"] .text-neon-cyan')?.textContent).toBe("@Alice");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!);
    expect(onSend).toHaveBeenCalledWith("@Alice(hu_alice) ", [], ["hu_alice"]);
    expect(document.activeElement).toBe(input());
  });

  it("keeps immediate typing after a selection in order and clears edited identities", async () => {
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Mention someone"]')!);
    await click(options()[0]);
    expect(input().selectionStart).toBe(7);
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(() => {
      setValue.call(input(), "@Alice hello");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!);
    expect(onSend).toHaveBeenLastCalledWith("@Alice(hu_alice) hello", [], ["hu_alice"]);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Mention someone"]')!);
    await click(options()[0]);
    await act(() => {
      setValue.call(input(), "@Alic hello");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!);
    expect(onSend).toHaveBeenLastCalledWith("@Alic hello", [], undefined);
  });

  it("keeps Escape closed after keyup", async () => {
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Mention someone"]')!);
    await key("Escape");
    expect(options()).toHaveLength(0);
    expect(input().value).toBe("@");
  });

  it("leaves IME arrows and Enter to the input method", async () => {
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Mention someone"]')!);
    await key("ArrowDown", true);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    await key("Escape", true);
    expect(options()).toHaveLength(2);
    await key("Enter", true);
    expect(input().value).toBe("@");
    expect(onSend).not.toHaveBeenCalled();
    await key("ArrowDown");
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    await key("Enter");
    expect(input().value).toBe("@Helper ");
  });
});
