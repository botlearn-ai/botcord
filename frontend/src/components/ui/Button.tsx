/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-accent、text-on-accent…，见 styles/botcord-tailwind.css）、lucide Loader2 与 clsx
 * [OUTPUT]: 对外提供 Button：primary / secondary / ghost / danger 四种变体，sm / md 两种尺寸，可选 loading
 * [POS]: ui 基础原语；dashboard 与营销页的按钮统一从这里出，不再手写按钮 className
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；样式规则以 docs/brand/botcord-vi/VI.md §3、§9 为准
 */

import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  // One primary action per view (VI §3.7).
  primary: "border border-accent bg-accent text-on-accent hover:border-accent-hover hover:bg-accent-hover",
  secondary: "liquid-action text-text-primary hover:text-text-primary",
  ghost: "border border-transparent text-text-secondary hover:bg-surface-sunken hover:text-text-primary",
  danger: "border border-danger/40 bg-danger-soft text-danger hover:border-danger/70",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-xs",
  md: "h-10 gap-2 rounded-lg px-4 text-sm",
};

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
      className={clsx(
        "bc-touch-target inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60",
        "disabled:cursor-not-allowed disabled:opacity-55",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className={size === "sm" ? "h-3.5 w-3.5 animate-spin" : "h-4 w-4 animate-spin"} /> : null}
      {children}
    </button>
  );
});

export default Button;
