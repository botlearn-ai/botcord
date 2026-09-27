"use client";

import { useEffect, useState } from "react";

/** Keep the app inside the visible viewport while mobile browser chrome / keyboards move. */
export function useChatViewport() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!root || !viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!window.matchMedia("(max-width: 767px)").matches || viewport.scale !== 1) {
          root.style.removeProperty("height");
          root.style.removeProperty("top");
          delete root.dataset.keyboardOpen;
          return;
        }
        root.style.height = `${viewport.height}px`;
        root.style.top = `${viewport.offsetTop}px`;
        const editing = document.activeElement?.matches("textarea, input, [contenteditable=true]");
        root.dataset.keyboardOpen = String(Boolean(editing && window.innerHeight - viewport.height > 120));
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
    };
  }, [root]);
  return setRoot;
}
