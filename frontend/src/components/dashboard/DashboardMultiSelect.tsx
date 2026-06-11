"use client";

/**
 * [INPUT]: 受控的 option/value/onChange 与可选分组、搜索文案
 * [OUTPUT]: 对外提供 DashboardMultiSelect，渲染带受控动效的 BotCord dashboard 风格可搜索多选下拉
 * [POS]: dashboard 表单和弹窗里的统一多选控件，替代分散的原生/临时多选列表
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { animatePop, animateIfMotion, animeStagger, cleanupAnime } from "@/lib/anime";

export interface DashboardMultiSelectOption {
  value: string;
  label: string;
  sublabel?: string;
  badge?: string;
  tone?: "cyan" | "green" | "purple" | "zinc";
  icon?: ReactNode;
}

export interface DashboardMultiSelectGroup {
  label?: string;
  options: DashboardMultiSelectOption[];
}

interface DashboardMultiSelectProps {
  value: string[];
  onChange: (value: string[]) => void;
  groups?: DashboardMultiSelectGroup[];
  options?: DashboardMultiSelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  selectedLabel?: (count: number) => string;
  disabled?: boolean;
  className?: string;
  panelClassName?: string;
}

const toneClasses = {
  cyan: "bg-neon-cyan/10 text-neon-cyan",
  green: "bg-neon-green/10 text-neon-green",
  purple: "bg-neon-purple/10 text-neon-purple",
  zinc: "bg-zinc-700/50 text-zinc-300",
};

export default function DashboardMultiSelect({
  value,
  onChange,
  groups,
  options,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  selectedLabel = (count) => `${count} selected`,
  disabled = false,
  className = "",
  panelClassName = "",
}: DashboardMultiSelectProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef(new Map<string, HTMLSpanElement>());
  const selectedCheckRefs = useRef(new Map<string, HTMLSpanElement>());
  const overflowChipRef = useRef<HTMLSpanElement>(null);
  const selectedCountRef = useRef<HTMLSpanElement>(null);
  const panelAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const optionAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const selectionAnimationRefs = useRef<Array<ReturnType<typeof animatePop>>>([]);
  const previousValueRef = useRef(value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const normalizedGroups = useMemo<DashboardMultiSelectGroup[]>(() => {
    if (groups) return groups;
    return [{ options: options ?? [] }];
  }, [groups, options]);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const optionByValue = useMemo(() => {
    const map = new Map<string, DashboardMultiSelectOption>();
    for (const group of normalizedGroups) {
      for (const option of group.options) map.set(option.value, option);
    }
    return map;
  }, [normalizedGroups]);

  const selectedOptions = value
    .map((selectedValue) => optionByValue.get(selectedValue))
    .filter((option): option is DashboardMultiSelectOption => Boolean(option));

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return normalizedGroups;
    return normalizedGroups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => {
          return (
            option.label.toLowerCase().includes(q) ||
            option.sublabel?.toLowerCase().includes(q) ||
            option.badge?.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((group) => group.options.length > 0);
  }, [normalizedGroups, query]);

  const visibleCount = filteredGroups.reduce((sum, group) => sum + group.options.length, 0);
  const visibleOptionKey = useMemo(
    () => filteredGroups.flatMap((group) => group.options.map((option) => option.value)).join("\u0000"),
    [filteredGroups],
  );
  const valueKey = useMemo(() => value.join("\u0000"), [value]);

  const cleanupSelectionAnimations = useCallback(() => {
    selectionAnimationRefs.current.forEach(cleanupAnime);
    selectionAnimationRefs.current = [];
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) window.setTimeout(() => searchRef.current?.focus(), 0);
    else setQuery("");
  }, [open]);

  useEffect(() => {
    return () => {
      cleanupAnime(panelAnimationRef.current);
      cleanupAnime(optionAnimationRef.current);
      cleanupSelectionAnimations();
    };
  }, [cleanupSelectionAnimations]);

  useLayoutEffect(() => {
    if (!open) {
      cleanupAnime(panelAnimationRef.current);
      cleanupAnime(optionAnimationRef.current);
      panelAnimationRef.current = null;
      optionAnimationRef.current = null;
      return;
    }

    let panelAnimation: ReturnType<typeof animateIfMotion> = null;
    const frameId = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;

      cleanupAnime(panelAnimationRef.current);

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

      panelAnimationRef.current = panelAnimation;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      cleanupAnime(panelAnimation);
      if (panelAnimationRef.current === panelAnimation) panelAnimationRef.current = null;
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    let optionAnimation: ReturnType<typeof animateIfMotion> = null;
    const frameId = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;

      cleanupAnime(optionAnimationRef.current);

      const optionNodes = Array.from(
        panel.querySelectorAll<HTMLElement>("[data-dashboard-multi-option]"),
      ).slice(0, 16);

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

      optionAnimationRef.current = optionAnimation;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      cleanupAnime(optionAnimation);
      if (optionAnimationRef.current === optionAnimation) optionAnimationRef.current = null;
    };
  }, [open, visibleOptionKey]);

  useEffect(() => {
    const previousValue = previousValueRef.current;
    const previousSet = new Set(previousValue);
    const addedValue = value.find((selectedValue) => !previousSet.has(selectedValue)) ?? null;
    previousValueRef.current = value;

    if (!addedValue) return;

    const frameId = window.requestAnimationFrame(() => {
      cleanupSelectionAnimations();

      const targets = [
        chipRefs.current.get(addedValue) ?? overflowChipRef.current,
        selectedCountRef.current,
        selectedCheckRefs.current.get(addedValue),
      ].filter((target): target is HTMLElement => Boolean(target));

      selectionAnimationRefs.current = targets.map((target) => animatePop(target));
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [cleanupSelectionAnimations, value, valueKey]);

  const toggle = (optionValue: string) => {
    const next = new Set(selectedSet);
    if (next.has(optionValue)) next.delete(optionValue);
    else next.add(optionValue);
    onChange(Array.from(next));
  };

  const clear = () => onChange([]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-left text-sm text-text-primary transition-colors hover:border-neon-cyan/30 disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
      >
        <span className="min-w-0 flex-1">
          {selectedOptions.length === 0 ? (
            <span className="text-text-secondary/70">{placeholder}</span>
          ) : (
            <span className="flex min-w-0 flex-wrap gap-1.5">
              {selectedOptions.slice(0, 3).map((option) => (
                <span
                  key={option.value}
                  ref={(node) => {
                    if (node) chipRefs.current.set(option.value, node);
                    else chipRefs.current.delete(option.value);
                  }}
                  className="inline-block max-w-[11rem] origin-center truncate rounded border border-neon-cyan/20 bg-neon-cyan/10 px-2 py-0.5 text-xs text-neon-cyan"
                >
                  {option.label}
                </span>
              ))}
              {selectedOptions.length > 3 ? (
                <span
                  ref={overflowChipRef}
                  className="inline-block origin-center rounded border border-glass-border bg-deep-black-light px-2 py-0.5 text-xs text-text-secondary"
                >
                  +{selectedOptions.length - 3}
                </span>
              ) : null}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span ref={selectedCountRef} className="min-w-[4.5rem] origin-center text-right text-[11px] text-text-secondary">
            {selectedLabel(selectedOptions.length)}
          </span>
          <ChevronDown className={`h-4 w-4 text-text-secondary transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={`${id}-panel`}
          className={`absolute left-0 right-0 z-40 mt-2 overflow-hidden rounded-xl border border-glass-border bg-deep-black-light shadow-2xl shadow-black/40 ${panelClassName}`}
        >
          <div className="border-b border-glass-border p-2">
            <div className="flex items-center gap-2 rounded-lg border border-glass-border bg-deep-black px-2.5">
              <Search className="h-3.5 w-3.5 text-text-secondary/70" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent py-2 text-xs text-text-primary outline-none placeholder:text-text-secondary/50"
              />
              {value.length > 0 ? (
                <button
                  type="button"
                  onClick={clear}
                  className="rounded p-1 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
                  aria-label="Clear selected"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
            {visibleCount === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-text-secondary/70">{emptyLabel}</p>
            ) : (
              filteredGroups.map((group, groupIndex) => (
                <div key={group.label ?? groupIndex} className="py-1">
                  {group.label ? (
                    <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-secondary/60">
                      {group.label}
                    </p>
                  ) : null}
                  {group.options.map((option) => {
                    const selected = selectedSet.has(option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => toggle(option.value)}
                        data-dashboard-multi-option
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors ${
                          selected ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-primary hover:bg-glass-bg"
                        }`}
                      >
                        <span
                          ref={(node) => {
                            if (node && selected) selectedCheckRefs.current.set(option.value, node);
                            else selectedCheckRefs.current.delete(option.value);
                          }}
                          className={`flex h-4 w-4 shrink-0 origin-center items-center justify-center rounded border ${
                            selected
                              ? "border-neon-cyan bg-neon-cyan text-deep-black"
                              : "border-glass-border bg-deep-black-light"
                          }`}
                        >
                          {selected ? <Check className="h-3 w-3" /> : null}
                        </span>
                        {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{option.label}</span>
                          {option.sublabel ? (
                            <span className="mt-0.5 block truncate font-mono text-[10px] text-text-secondary/70">
                              {option.sublabel}
                            </span>
                          ) : null}
                        </span>
                        {option.badge ? (
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              toneClasses[option.tone ?? "zinc"]
                            }`}
                          >
                            {option.badge}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
