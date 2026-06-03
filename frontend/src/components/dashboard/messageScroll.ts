export const CHAT_SCROLL_BOTTOM_THRESHOLD = 150;

export type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

export function isNearScrollBottom(
  metrics: ScrollMetrics,
  threshold = CHAT_SCROLL_BOTTOM_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function scrollToLatestVisibleAfterScroll(
  currentlyVisible: boolean,
  nearBottom: boolean,
): boolean {
  return nearBottom ? false : currentlyVisible;
}

export function shouldShowScrollToLatestForNewContent({
  wasNearBottom,
  hadPreviousContent,
  isLoadingMore,
}: {
  wasNearBottom: boolean;
  hadPreviousContent: boolean;
  isLoadingMore: boolean;
}): boolean {
  return !isLoadingMore && hadPreviousContent && !wasNearBottom;
}
