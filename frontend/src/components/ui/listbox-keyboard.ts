import type { KeyboardEvent } from "react";

/** Move focus through enabled options; native buttons retain Enter/Space selection. */
export function moveListboxFocus(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !root) return;
  // Home/End still edit the search text while the input is focused.
  if (event.target instanceof HTMLInputElement && ["Home", "End"].includes(event.key)) return;
  const options = [...root.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
  if (!options.length) return;
  event.preventDefault();
  const current = options.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 :
    current < 0 ? (event.key === "ArrowUp" ? options.length - 1 : 0) :
    (current + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
  options[index].focus();
}
