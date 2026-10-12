/**
 * [INPUT]: 依赖原生 <input type="checkbox">（indeterminate 属性）、VI 颜色语义类（bg-accent、border-border-strong…）、lucide Check / Minus 与 clsx
 * [OUTPUT]: 对外提供 Checkbox：checked 支持 true / false / "indeterminate"，可选右侧 label
 * [POS]: ui 交互原语（批次 2）；表单与批量选择的复选框统一从这里出
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；样式规则以 VI.md §3、§9 为准
 */
"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";
import { Check, Minus } from "lucide-react";

export type CheckboxState = boolean | "indeterminate";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "checked" | "onChange" | "type" | "size"> {
  checked: CheckboxState;
  /** Clicking an indeterminate box reports true. */
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
}

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onCheckedChange, label, disabled, className, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);
  const indeterminate = checked === "indeterminate";

  // indeterminate is a DOM property only (exposed to AT as "mixed"); sync it after every render.
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  });

  const Icon = indeterminate ? Minus : Check;

  return (
    <label
      className={clsx(
        "bc-touch-target inline-flex items-center gap-2 text-sm text-text-primary",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <span className="relative inline-flex h-4 w-4 shrink-0">
        <input
          ref={inputRef}
          type="checkbox"
          checked={checked === true}
          disabled={disabled}
          onChange={(event) => {
            onCheckedChange(event.target.checked);
            // Stays mixed until the parent passes a new value (the effect then syncs it).
            if (indeterminate) event.target.indeterminate = true;
          }}
          className={clsx(
            "h-4 w-4 cursor-[inherit] appearance-none rounded border border-border-strong bg-surface",
            "transition-colors duration-[var(--bc-duration-fast)] motion-reduce:transition-none",
            "checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60",
          )}
          {...rest}
        />
        <Icon
          aria-hidden
          strokeWidth={3}
          className={clsx(
            "pointer-events-none absolute inset-0 m-auto h-3 w-3 text-on-accent",
            checked === false && "hidden",
          )}
        />
      </span>
      {label != null ? <span>{label}</span> : null}
    </label>
  );
});

export default Checkbox;
