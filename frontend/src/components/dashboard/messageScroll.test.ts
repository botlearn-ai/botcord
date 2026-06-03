import { describe, expect, it } from "vitest";
import {
  CHAT_SCROLL_BOTTOM_THRESHOLD,
  isNearScrollBottom,
  scrollToLatestVisibleAfterScroll,
  shouldShowScrollToLatestForNewContent,
  type ScrollMetrics,
} from "./messageScroll";

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

describe("scrollToLatestVisibleAfterScroll", () => {
  it("keeps the button hidden when the user only scrolls away from bottom", () => {
    expect(scrollToLatestVisibleAfterScroll(false, false)).toBe(false);
  });

  it("keeps an already visible button visible while the user remains away from bottom", () => {
    expect(scrollToLatestVisibleAfterScroll(true, false)).toBe(true);
  });

  it("hides the button once the user returns near bottom", () => {
    expect(scrollToLatestVisibleAfterScroll(true, true)).toBe(false);
  });
});

describe("shouldShowScrollToLatestForNewContent", () => {
  it("reveals the button for new content while auto-follow is paused", () => {
    expect(shouldShowScrollToLatestForNewContent({
      wasNearBottom: false,
      hadPreviousContent: true,
      isLoadingMore: false,
    })).toBe(true);
  });

  it("does not reveal the button for initial content or history pagination", () => {
    expect(shouldShowScrollToLatestForNewContent({
      wasNearBottom: false,
      hadPreviousContent: false,
      isLoadingMore: false,
    })).toBe(false);
    expect(shouldShowScrollToLatestForNewContent({
      wasNearBottom: false,
      hadPreviousContent: true,
      isLoadingMore: true,
    })).toBe(false);
  });
});
