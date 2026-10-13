/**
 * [INPUT]: Required accessible label and native button attributes
 * [OUTPUT]: Square icon action with shared focus and disabled states
 * [POS]: UI icon-only action primitive; labelled actions use Button
 * [PROTOCOL]: Keep size and tone aligned with the component contract
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { label: string; size?: "sm" | "md"; danger?: boolean }
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, size = "md", danger, className, type = "button", children, ...props }, ref) {
  return <button {...props} ref={ref} type={type} aria-label={label} title={props.title ?? label} className={clsx("bc-touch-target inline-flex shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50", size === "sm" ? "h-8 w-8" : "h-10 w-10", danger ? "text-danger hover:bg-danger-soft" : "text-text-secondary hover:bg-surface-sunken hover:text-text-primary aria-pressed:bg-accent-soft aria-pressed:text-accent-text", className)}><span aria-hidden className="inline-flex [&>svg]:h-4 [&>svg]:w-4">{children}</span></button>;
});
export default IconButton;
