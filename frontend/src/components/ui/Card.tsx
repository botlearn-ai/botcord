/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-surface、bg-surface-sunken、border-border、ring-focus-ring…）与 clsx
 * [OUTPUT]: 对外提供 Card：default / sunken / interactive 三种变体，none / sm / md / lg 四档内边距，可渲染为 div / section / article / button
 * [POS]: ui 基础原语；dashboard 面板、列表卡片、可点击卡片统一从这里出，不再手写卡片 className
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；圆角与颜色以 docs/brand/botcord-vi/VI.md §3.5、§9 为准
 */

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes, Ref } from "react";
import { clsx } from "clsx";

export type CardVariant = "default" | "sunken" | "interactive";
export type CardPadding = "none" | "sm" | "md" | "lg";
export type CardElement = "div" | "section" | "article" | "button";

const VARIANT: Record<CardVariant, string> = {
  default: "bg-surface",
  sunken: "bg-surface-sunken",
  interactive:
    "cursor-pointer bg-surface transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60",
};

const PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export interface CardProps extends HTMLAttributes<HTMLElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  as?: CardElement;
  /** Only applies when `as="button"`; defaults to "button". */
  type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
  /** Only applies when `as="button"`. */
  disabled?: boolean;
}

const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { variant = "default", padding = "md", as = "div", type, disabled, className, ...rest },
  ref,
) {
  const classes = clsx(
    "block rounded-xl border border-border",
    VARIANT[variant],
    PADDING[padding],
    as === "button" && "w-full text-left disabled:cursor-not-allowed disabled:opacity-55",
    className,
  );

  if (as === "button") {
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type={type ?? "button"}
        disabled={disabled}
        className={classes}
        {...rest}
      />
    );
  }

  const Tag = as;
  return <Tag ref={ref as Ref<HTMLDivElement>} className={classes} {...rest} />;
});

export default Card;
