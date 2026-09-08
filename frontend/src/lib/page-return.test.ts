import { describe, expect, it, vi } from "vitest";
import { subscribeToPageReturn } from "./page-return";

function makePage() {
  return Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
}

describe("page return refresh", () => {
  it("ignores repeated focus and already-visible events", () => {
    const page = makePage();
    const refresh = vi.fn();
    const stop = subscribeToPageReturn(refresh, page);
    for (let i = 0; i < 5; i++) {
      page.dispatchEvent(new Event("focus"));
      page.dispatchEvent(new Event("visibilitychange"));
    }
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("refreshes once per real return and detaches on unmount", () => {
    const page = makePage();
    const refresh = vi.fn();
    const stop = subscribeToPageReturn(refresh, page);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    page.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
