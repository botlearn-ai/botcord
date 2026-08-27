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

/** A stable, visible message element used to preserve the reader's viewport
 * while an older page is prepended. Unlike scrollHeight deltas, this remains
 * correct if a realtime message is appended at the bottom mid-request. */
export type VisibleMessageScrollAnchor = {
  key: string;
  offsetFromViewportTop: number;
};

export function captureVisibleMessageScrollAnchor(
  container: HTMLElement,
  selector: string,
  keyAttribute: string,
): VisibleMessageScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const message = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
    (element) => element.getBoundingClientRect().bottom > containerTop,
  );
  const key = message?.getAttribute(keyAttribute);
  if (!message || !key) return null;
  return {
    key,
    offsetFromViewportTop: message.getBoundingClientRect().top - containerTop,
  };
}

export function restoreVisibleMessageScrollAnchor(
  container: HTMLElement,
  selector: string,
  keyAttribute: string,
  anchor: VisibleMessageScrollAnchor,
): boolean {
  const message = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
    (element) => element.getAttribute(keyAttribute) === anchor.key,
  );
  if (!message) return false;
  const nextOffset = message.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const delta = nextOffset - anchor.offsetFromViewportTop;
  if (delta !== 0) container.scrollTop += delta;
  return true;
}
