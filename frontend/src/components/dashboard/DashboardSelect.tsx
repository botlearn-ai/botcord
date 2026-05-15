"use client";

/**
 * [INPUT]: 受控 value/options/onChange 与可选图标、占位文案
 * [OUTPUT]: DashboardSelect — dashboard 风格的单选下拉控件，替代弹窗中的原生 select
 * [POS]: dashboard 表单和弹窗里的统一单选控件
 * [PROTOCOL]: 变更时更新此头部
 */

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface DashboardSelectOption {
  value: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
}

interface DashboardSelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  options: DashboardSelectOption[];
  placeholder: string;
  disabled?: boolean;
  leadingIcon?: ReactNode;
  className?: string;
  buttonClassName?: string;
  panelClassName?: string;
}

export default function DashboardSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  leadingIcon,
  className = "",
  buttonClassName = "",
  panelClassName = "",
}: DashboardSelectProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
        className={`flex min-h-10 w-full items-center justify-between gap-3 rounded-xl border border-glass-border bg-deep-black px-3 text-left text-sm text-text-primary transition-colors hover:border-neon-cyan/45 focus:border-neon-cyan focus:outline-none focus:ring-1 focus:ring-neon-cyan/50 disabled:cursor-not-allowed disabled:opacity-50 ${buttonClassName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {leadingIcon ? <span className="shrink-0">{leadingIcon}</span> : null}
          <span className="min-w-0">
            <span className={`block truncate ${selected ? "text-text-primary" : "text-text-secondary/70"}`}>
              {selected?.label ?? placeholder}
            </span>
            {selected?.sublabel ? (
              <span className="mt-0.5 block truncate font-mono text-[10px] text-text-secondary/60">
                {selected.sublabel}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-text-secondary transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          id={`${id}-panel`}
          role="listbox"
          className={`absolute left-0 right-0 z-50 mt-2 max-h-64 overflow-y-auto rounded-xl border border-glass-border bg-deep-black-light py-1 shadow-2xl shadow-black/40 ${panelClassName}`}
        >
          {options.length === 0 ? (
            <p className="px-3 py-3 text-xs text-text-secondary/70">{placeholder}</p>
          ) : (
            options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  onClick={() => {
                    if (option.disabled) return;
                    onChange(option.value);
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                    isSelected ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-primary hover:bg-glass-bg"
                  }`}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.sublabel ? (
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-text-secondary/65">
                        {option.sublabel}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
