import { describe, expect, it } from "vitest";
import { CHAT_SCROLL_BOTTOM_THRESHOLD, isNearScrollBottom, type ScrollMetrics } from "./messageScroll";

function metrics(overrides: Partial<ScrollMetrics> = {}): ScrollMetrics {
  return {
    clientHeight: 500,
    scrollHeight: 2000,
    scrollTop: 1500,
    ...overrides,
  };
}

describe("isNearScrollBottom", () => {
  it("treats the viewport as near bottom within the chat threshold", () => {
    expect(isNearScrollBottom(metrics({
      scrollTop: 2000 - 500 - CHAT_SCROLL_BOTTOM_THRESHOLD,
    }))).toBe(true);
  });

  it("treats upward scrolling past the threshold as away from bottom", () => {
    expect(isNearScrollBottom(metrics({
      scrollTop: 2000 - 500 - CHAT_SCROLL_BOTTOM_THRESHOLD - 1,
    }))).toBe(false);
  });
});
