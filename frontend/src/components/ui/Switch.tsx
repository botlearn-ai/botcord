/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-accent、bg-border-strong、bg-surface-raised…）与 clsx
 * [OUTPUT]: 对外提供 Switch：role="switch" + aria-checked 的开关按钮，sm / md 两种尺寸，可选右侧 label
 * [POS]: ui 交互原语（批次 2）；设置页等即时生效的二元开关统一从这里出
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；样式规则以 VI.md §3、§8、§9 为准
 */
"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";

export type SwitchSize = "sm" | "md";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "type"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: SwitchSize;
  label?: ReactNode;
}

const TRACK: Record<SwitchSize, string> = { sm: "h-4 w-7", md: "h-5 w-9" };
const THUMB: Record<SwitchSize, string> = { sm: "h-3 w-3", md: "h-4 w-4" };
const THUMB_ON: Record<SwitchSize, string> = { sm: "translate-x-3", md: "translate-x-4" };

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, size = "md", label, disabled, className, onClick, ...rest },
  ref,
) {
  const control = (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
      className={clsx(
        "relative inline-flex shrink-0 items-center rounded-full p-0.5",
        "transition-colors duration-[var(--bc-duration-fast)] motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent" : "bg-border-strong",
        TRACK[size],
        !label && className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={clsx(
          "block rounded-full bg-surface-raised shadow-[var(--bc-shadow-sm)]",
          "transition-transform duration-[var(--bc-duration-fast)] ease-[var(--bc-ease-standard)] motion-reduce:transition-none",
          THUMB[size],
          checked ? THUMB_ON[size] : "translate-x-0",
        )}
      />
    </button>
  );

  if (!label) return control;
  // Wrapping <label> gives the switch its accessible name and makes the text clickable.
  return (
    <label
      className={clsx(
        "inline-flex items-center gap-2 text-sm text-text-primary",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      {control}
      <span>{label}</span>
    </label>
  );
});

export default Switch;
