/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-accent、text-on-accent…，见 styles/botcord-tailwind.css）、lucide Loader2 与 clsx
 * [OUTPUT]: 对外提供 Button：primary / secondary / ghost / danger / row / inline 六种变体，sm / md 两种尺寸，可选 loading
 * [POS]: ui 基础原语；dashboard 与营销页的按钮统一从这里出，不再手写按钮 className
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；样式规则以 docs/brand/botcord-vi/VI.md §3、§9 为准
 */

import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "row" | "inline";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  // One primary action per view (VI §3.7).
  primary: "border border-accent bg-accent text-on-accent hover:border-accent-hover hover:bg-accent-hover",
  secondary: "liquid-action text-text-primary hover:text-text-primary aria-pressed:bg-accent-soft aria-pressed:text-accent-text aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-text",
  ghost: "border border-transparent text-text-secondary hover:bg-surface-sunken hover:text-text-primary aria-pressed:bg-accent-soft aria-pressed:text-accent-text aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-text",
  danger: "border border-danger/40 bg-danger-soft text-danger hover:border-danger/70",
  row: "block w-full rounded-lg border border-transparent px-3 py-2 text-left text-sm whitespace-normal text-text-primary hover:bg-surface-sunken aria-pressed:border-accent/30 aria-pressed:bg-accent-soft aria-pressed:text-accent-text aria-selected:border-accent/30 aria-selected:bg-accent-soft aria-selected:text-accent-text aria-[current=page]:border-accent/30 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-text data-[active=true]:border-accent/30 data-[active=true]:bg-accent-soft data-[active=true]:text-accent-text",
  inline: "inline-flex items-center gap-1 rounded align-baseline text-accent-text hover:underline underline-offset-2",

};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-xs",
  md: "h-10 gap-2 rounded-lg px-4 text-sm",
};


/** Shared action styling; links retain navigation semantics via LinkButton. */
export function buttonStyles(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return clsx(
    variant === "row" ? "bc-touch-target transition-colors" : variant === "inline" ? "transition-colors" : "bc-touch-target inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60 disabled:cursor-not-allowed disabled:opacity-55",
    VARIANT[variant],
    variant !== "row" && variant !== "inline" && SIZE[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button; children stay as the label. */
  loading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, disabled, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonStyles(variant, size, className)}
      {...rest}
    >
      {loading ? <Loader2 className={size === "sm" ? "h-3.5 w-3.5 animate-spin" : "h-4 w-4 animate-spin"} /> : null}
      {children}
    </button>
  );
});

export default Button;
