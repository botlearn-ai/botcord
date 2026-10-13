// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeChatViewport } from "./useChatViewport";

let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
let root: HTMLDivElement;
let input: HTMLTextAreaElement;
let dispose: () => void;
let mobile = true;

beforeEach(() => {
  vi.useFakeTimers();
  mobile = true;
  viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("matchMedia", () => ({ matches: mobile }));
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  root = document.createElement("div");
  input = document.createElement("textarea");
  root.append(input);
  document.body.append(root);
  dispose = observeChatViewport(root);
  vi.runAllTimers();
});
afterEach(() => {
  dispose();
  root.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function update(type = "scroll") {
  viewport.dispatchEvent(new Event(type));
  vi.runAllTimers();
}

it("never moves a non-editing page for either direction of viewport bounce", () => {
  for (const offset of [48, -48, 0]) {
    viewport.offsetTop = offset;
    update();
    expect(root.style.top).toBe("");
    expect(root.style.height).toBe("");
    expect(root.dataset.keyboardOpen).toBeUndefined();
  }
});

it("leaves browser-toolbar height changes to CSS, including when an input has focus", () => {
  input.focus();
  viewport.height = 730;
  viewport.offsetTop = 40;
  update("resize");
  expect(root.style.top).toBe("");
  expect(root.style.height).toBe("");
});

it("fits the keyboard viewport and clears compensation when the keyboard closes", () => {
  input.focus();
  viewport.height = 420;
  viewport.offsetTop = 80;
  update("resize");
  expect(root.style.top).toBe("80px");
  expect(root.style.height).toBe("420px");
  expect(root.dataset.keyboardOpen).toBe("true");
  viewport.height = 800;
  // Safari can report a stale offset during keyboard dismissal.
  update("resize");
  expect(root.style.top).toBe("");
  expect(root.style.height).toBe("");
  expect(root.dataset.keyboardOpen).toBeUndefined();
});

it("clears compensation on blur even before Safari restores viewport height", () => {
  input.focus();
  viewport.height = 420;
  update("resize");
  input.blur();
  vi.runAllTimers();
  expect(root.style.top).toBe("");
  expect(root.style.height).toBe("");
});

it("does not apply a negative bounce offset while the keyboard is open", () => {
  input.focus();
  viewport.height = 420;
  viewport.offsetTop = -30;
  update();
  expect(root.style.top).toBe("0px");
});

it("resets for desktop and zoom and removes all listeners on cleanup", () => {
  input.focus();
  viewport.height = 420;
  update();
  mobile = false;
  update();
  expect(root.style.height).toBe("");
  mobile = true;
  viewport.scale = 2;
  update();
  expect(root.style.height).toBe("");
  viewport.scale = 1;
  update();
  expect(root.style.height).toBe("420px");
  dispose();
  update();
  expect(root.style.height).toBe("");
  expect(root.dataset.keyboardOpen).toBeUndefined();
});
