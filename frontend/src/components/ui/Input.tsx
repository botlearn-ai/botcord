/**
 * [INPUT]: 依赖全局 liquid-input 样式（focus / aria-invalid 状态在 globals.css）与 clsx
 * [OUTPUT]: 对外提供 Input 与 Textarea：统一圆角、内边距、字号与校验态
 * [POS]: ui 基础原语，表单输入统一从这里出
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；样式规则以 docs/brand/botcord-vi/VI.md §9 为准
 */

import { forwardRef } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { clsx } from "clsx";

const FIELD =
  "liquid-input w-full rounded-lg px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-60";

const MESSAGE = "w-full min-h-11 border-0 bg-transparent px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-1 focus-visible:ring-focus-ring";
const COMPOSER = "w-full border-0 bg-transparent p-0 text-sm text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-1 focus-visible:ring-focus-ring";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the field invalid; styling comes from `.liquid-input[aria-invalid]`. */
  invalid?: boolean;
  /** Borderless embedded editor; callers own sizing and input/composition logic. */
  variant?: "default" | "composer" | "message";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, variant = "default", className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx(variant === "composer" ? COMPOSER : variant === "message" ? MESSAGE : FIELD, variant === "default" && "h-10", className)}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Borderless embedded editor; callers own sizing and input/composition logic. */
  variant?: "default" | "composer" | "message";
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, variant = "default", className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx(variant === "composer" ? COMPOSER : variant === "message" ? MESSAGE : FIELD, variant !== "default" ? "resize-none leading-relaxed" : "min-h-20 py-2 leading-relaxed", className)}
      {...rest}
    />
  );
});
