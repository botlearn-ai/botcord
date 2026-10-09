/** Touch keyboards need Return for newlines; desktop retains Enter to send. */
export function shouldSendOnEnter(key: string, shiftKey: boolean, composing: boolean, touch: boolean): boolean {
  return key === "Enter" && !shiftKey && !composing && !touch;
}

export function composerPopoverGeometry(anchor: { left: number; top: number; width: number }, viewport: { left: number; top: number; width: number; height: number }, width: number) {
  const padding = 8;
  const panelWidth = Math.min(width, viewport.width - padding * 2);
  const bottom = Math.min(anchor.top - padding, viewport.top + viewport.height - padding);
  return {
    left: Math.max(viewport.left + padding, Math.min(anchor.left, viewport.left + viewport.width - panelWidth - padding)),
    top: bottom,
    width: panelWidth,
    maxHeight: Math.max(0, Math.min(280, bottom - viewport.top - padding)),
  };
}

/** Keep a reader following the latest message when the keyboard or composer resizes the feed. */
export function observeChatViewportResize(
  container: HTMLElement,
  shouldFollow: () => boolean,
  follow: () => void,
): () => void {
  let height = container.clientHeight;
  const observer = new ResizeObserver(() => {
    const nextHeight = container.clientHeight;
    if (nextHeight === height) return;
    height = nextHeight;
    if (shouldFollow()) follow();
  });
  observer.observe(container);
  return () => observer.disconnect();
}
