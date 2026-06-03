export const CHAT_SCROLL_BOTTOM_THRESHOLD = 150;

export type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

export function isNearScrollBottom(
  metrics: ScrollMetrics,
  threshold = CHAT_SCROLL_BOTTOM_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
