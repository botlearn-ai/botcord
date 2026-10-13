"use client";

import { useEffect, useState } from "react";

/** Only a software keyboard needs visual-viewport positioning. Safari's normal
 * scrolling/bounce offsets must never be copied into the fixed app shell. */
export function observeChatViewport(root: HTMLDivElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  let frame = 0;
  const clear = () => {
    root.style.removeProperty("height");
    root.style.removeProperty("top");
    delete root.dataset.keyboardOpen;
  };
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const editing = document.activeElement?.matches("textarea, input, [contenteditable=true]");
      const keyboardOpen = Boolean(editing && window.innerHeight - viewport.height > 120);
      if (!window.matchMedia("(max-width: 767px)").matches || viewport.scale !== 1 || !keyboardOpen) {
        // CSS 100dvh tracks browser chrome without moving the shell in response
        // to an ordinary scroll event. Keep native content scrolling intact.
        clear();
        return;
      }
      root.style.height = `${viewport.height}px`;
      root.style.top = `${Math.max(0, viewport.offsetTop)}px`;
      root.dataset.keyboardOpen = "true";
    });
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", update);
  return () => {
    cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", update);
    clear();
  };
}

/** The fixed dashboard uses CSS sizing except while a mobile keyboard is open. */
export function useChatViewport() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (root) return observeChatViewport(root);
  }, [root]);
  return setRoot;
}
