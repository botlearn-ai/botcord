export interface ActionMenuAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ActionMenuPositionOptions {
  anchorRect: ActionMenuAnchorRect;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  alignRight: boolean;
  gap: number;
  viewportPadding: number;
}

export interface ActionMenuPosition {
  left: number;
  top: number;
  placement: "above" | "below";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getActionMenuPosition({
  anchorRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  alignRight,
  gap,
  viewportPadding,
}: ActionMenuPositionOptions): ActionMenuPosition {
  const maxLeft = Math.max(viewportPadding, viewportWidth - menuWidth - viewportPadding);
  const rawLeft = alignRight ? anchorRect.right - menuWidth : anchorRect.left;
  const left = clamp(rawLeft, viewportPadding, maxLeft);

  const spaceBelow = viewportHeight - anchorRect.bottom - viewportPadding;
  const spaceAbove = anchorRect.top - viewportPadding;
  const placeAbove = spaceBelow < menuHeight + gap && spaceAbove > spaceBelow;
  const rawTop = placeAbove
    ? anchorRect.top - menuHeight - gap
    : anchorRect.bottom + gap;
  const maxTop = Math.max(viewportPadding, viewportHeight - menuHeight - viewportPadding);
  const top = clamp(rawTop, viewportPadding, maxTop);

  return { left, top, placement: placeAbove ? "above" : "below" };
}
