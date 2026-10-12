"use client";
/**
 * [INPUT]: Existing popover close handler, animation ref and placement classes
 * [OUTPUT]: Shared full-area dismissal surface without action-button sizing
 * [POS]: Composable backdrop for responsive navigation; modal forms use DialogShell/Surface
 * [PROTOCOL]: Caller owns positioning, Escape and focus; className must not override the scrim tone
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";
export interface DismissLayerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> { label: string; type?: "button" }
const DismissLayer = forwardRef<HTMLButtonElement, DismissLayerProps>(function DismissLayer({ label, className, ...props }, ref) {
  return <button {...props} ref={ref} type="button" tabIndex={-1} aria-label={label} className={clsx("liquid-scrim border-0 p-0", className)} />;
});
export default DismissLayer;
