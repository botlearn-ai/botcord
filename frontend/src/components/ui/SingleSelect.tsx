"use client";

/**
 * [INPUT]: 受控 value/options/onChange 与可选图标、占位文案
 * [OUTPUT]: SingleSelect — 带说明与键盘导航的共享单选下拉控件
 * [POS]: ui 表单原语，dashboard 旧入口保留兼容导出
 * [PROTOCOL]: 变更时更新此头部
 */

import { moveListboxFocus } from "./listbox-keyboard";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { animatePop, animateIfMotion, animeStagger, cleanupAnime, prefersReducedMotion } from "@/lib/anime";

export interface SingleSelectOption {
  value: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
}

export interface SingleSelectProps extends Pick<ButtonHTMLAttributes<HTMLButtonElement>, "id" | "aria-label" | "aria-labelledby" | "aria-describedby" | "aria-invalid"> {
  value: string | null;
  onChange: (value: string | null) => void;
  options: SingleSelectOption[];
  placeholder: string;
  disabled?: boolean;
  leadingIcon?: ReactNode;
  className?: string;
  buttonClassName?: string;
  panelClassName?: string;
}

export default function SingleSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  leadingIcon,
  className = "",
  buttonClassName = "",
  panelClassName = "",
  ...controlProps
}: SingleSelectProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedCheckRef = useRef<HTMLSpanElement>(null);
  const panelAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const optionAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const checkAnimationRef = useRef<ReturnType<typeof animatePop>>(null);
  const selectCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      (panel?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );
  const optionKey = useMemo(() => options.map((option) => option.value).join("\u0000"), [options]);

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

  useEffect(() => {
    if (open || !selectCloseTimerRef.current) return;
    clearTimeout(selectCloseTimerRef.current);
    selectCloseTimerRef.current = null;
  }, [open]);

  useEffect(() => {
    return () => {
      if (selectCloseTimerRef.current) clearTimeout(selectCloseTimerRef.current);
      cleanupAnime(panelAnimationRef.current);
      cleanupAnime(optionAnimationRef.current);
      cleanupAnime(checkAnimationRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      cleanupAnime(panelAnimationRef.current);
      cleanupAnime(optionAnimationRef.current);
      panelAnimationRef.current = null;
      optionAnimationRef.current = null;
      return;
    }

    let panelAnimation: ReturnType<typeof animateIfMotion> = null;
    let optionAnimation: ReturnType<typeof animateIfMotion> = null;
    const frameId = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;

      cleanupAnime(panelAnimationRef.current);
      cleanupAnime(optionAnimationRef.current);

      panel.style.opacity = "0";
      panel.style.transform = "translateY(6px) scale(0.985)";
      panel.style.transformOrigin = "top center";

      panelAnimation = animateIfMotion(panel, {
        opacity: [0, 1],
        translateY: [6, 0],
        scale: [0.985, 1],
        duration: 180,
        ease: "out(3)",
      });

      if (!panelAnimation) {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0px) scale(1)";
      }

      const optionNodes = Array.from(
        panel.querySelectorAll<HTMLElement>("[data-dashboard-select-option]"),
      ).slice(0, 14);

      if (optionNodes.length > 0) {
        optionAnimation = animateIfMotion(optionNodes, {
          opacity: [0, 1],
          translateY: [4, 0],
          scale: [0.985, 1],
          delay: animeStagger(12, { start: 35 }),
          duration: 170,
          ease: "out(3)",
        });

        if (!optionAnimation) {
          optionNodes.forEach((optionNode) => {
            optionNode.style.opacity = "1";
            optionNode.style.transform = "translateY(0px) scale(1)";
          });
        }
      }

      panelAnimationRef.current = panelAnimation;
      optionAnimationRef.current = optionAnimation;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      cleanupAnime(panelAnimation);
      cleanupAnime(optionAnimation);
      if (panelAnimationRef.current === panelAnimation) panelAnimationRef.current = null;
      if (optionAnimationRef.current === optionAnimation) optionAnimationRef.current = null;
    };
  }, [open, optionKey]);

  useEffect(() => {
    if (!open || !value) return;

    const frameId = window.requestAnimationFrame(() => {
      const selectedCheck = selectedCheckRef.current;
      if (!selectedCheck) return;

      cleanupAnime(checkAnimationRef.current);
      checkAnimationRef.current = animatePop(selectedCheck);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [open, value]);

  const closeAfterSelection = (delayForCheckPop: boolean) => {
    if (selectCloseTimerRef.current) {
      clearTimeout(selectCloseTimerRef.current);
      selectCloseTimerRef.current = null;
    }

    if (!delayForCheckPop) {
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }

    selectCloseTimerRef.current = setTimeout(() => {
      selectCloseTimerRef.current = null;
      setOpen(false);
      buttonRef.current?.focus();
    }, 130);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={(event) => {
      if (open) moveListboxFocus(event, panelRef.current);
      else if (!disabled && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); }
    }}>
      <button
        ref={buttonRef}
        {...controlProps}
        id={controlProps.id ?? `${id}-trigger`}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
        className={`liquid-input flex min-h-10 w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm text-text-primary transition-colors hover:border-accent/45 focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${buttonClassName}`}
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
              <span className="mt-0.5 block truncate font-mono text-xs text-text-secondary/60">
                {selected.sublabel}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-text-secondary transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={`${id}-panel`}
          role="listbox"
          aria-labelledby={controlProps.id ?? `${id}-trigger`}
          className={`liquid-menu absolute left-0 right-0 z-50 mt-2 max-h-64 overflow-y-auto rounded-xl border border-border py-1 ${panelClassName}`}
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
                    const shouldDelayClose = option.value !== value && !prefersReducedMotion();
                    onChange(option.value);
                    closeAfterSelection(shouldDelayClose);
                  }}
                  data-dashboard-select-option
                  className={`liquid-list-row flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                    isSelected ? "!bg-accent/10 text-accent-text" : "text-text-primary hover:bg-surface-sunken"
                  }`}
                >
                  <span
                    ref={isSelected ? selectedCheckRef : undefined}
                    className="flex h-4 w-4 shrink-0 origin-center items-center justify-center"
                  >
                    {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.sublabel ? (
                      <span className="mt-0.5 block truncate font-mono text-xs text-text-secondary/65">
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
