/** Refresh only after a real background-to-visible transition, not DevTools focus. */
export function subscribeToPageReturn(
  onReturn: () => void,
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
): () => void {
  let wasHidden = page.visibilityState === "hidden";
  const onVisibilityChange = () => {
    if (page.visibilityState === "hidden") {
      wasHidden = true;
    } else if (page.visibilityState === "visible" && wasHidden) {
      wasHidden = false;
      onReturn();
    }
  };
  page.addEventListener("visibilitychange", onVisibilityChange);
  return () => page.removeEventListener("visibilitychange", onVisibilityChange);
}
