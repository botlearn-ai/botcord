// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindConversationBackSwipe } from "./useConversationBackSwipe";
let dispose: () => void;
let target: HTMLElement;
const back = vi.fn();
function touch(type: string, x: number, y: number, node = target, count = 1) {
  const points = Array.from({ length: count }, (_, identifier) => ({ clientX: x, clientY: y, identifier }));
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { touches: type === "touchend" ? [] : points, changedTouches: points });
  node.dispatchEvent(event);
  return event;
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  document.body.innerHTML = '<div data-mobile-conversation="true"><div id="feed"></div><textarea></textarea></div>';
  target = document.getElementById("feed")!;
  back.mockClear();
  dispose = bindConversationBackSwipe(document, back);
});
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
it("returns once on a deliberate rightward swipe from the left edge", () => {
  touch("touchstart", 10, 200);
  expect(touch("touchmove", 100, 204).defaultPrevented).toBe(true);
  touch("touchend", 130, 205);
  touch("touchend", 130, 205);
  expect(back).toHaveBeenCalledTimes(1);
});
it.each(["vertical", "short", "middle", "left", "multi", "cancel", "editor", "dialog", "list"])("ignores %s gestures", (kind) => {
  if (kind === "dialog") document.body.insertAdjacentHTML("beforeend", '<div aria-modal="true"></div>');
  if (kind === "list") target.parentElement!.dataset.mobileConversation = "false";
  const node = kind === "editor" ? document.querySelector("textarea")! : target;
  touch("touchstart", kind === "middle" ? 100 : 10, 200, node);
  if (kind === "vertical") touch("touchmove", 12, 250, node);
  if (kind === "multi") touch("touchmove", 20, 200, node, 2);
  if (kind === "cancel") touch("touchcancel", 100, 200, node);
  touch("touchend", kind === "short" ? 50 : kind === "left" ? 0 : 130, 205, node);
  expect(back).not.toHaveBeenCalled();
});
it("removes all listeners on cleanup", () => {
  dispose(); touch("touchstart", 10, 200); touch("touchend", 130, 200);
  expect(back).not.toHaveBeenCalled();
});
