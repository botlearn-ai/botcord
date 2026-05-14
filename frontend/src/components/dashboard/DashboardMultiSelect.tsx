"use client";

/**
 * [INPUT]: 受控的 option/value/onChange 与可选分组、搜索文案
 * [OUTPUT]: 对外提供 DashboardMultiSelect，渲染 BotCord dashboard 风格的可搜索多选下拉
 * [POS]: dashboard 表单和弹窗里的统一多选控件，替代分散的原生/临时多选列表
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

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
  const searchRef = useRef<HTMLInputElement>(null);
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
                  className="max-w-[11rem] truncate rounded border border-neon-cyan/20 bg-neon-cyan/10 px-2 py-0.5 text-xs text-neon-cyan"
                >
                  {option.label}
                </span>
              ))}
              {selectedOptions.length > 3 ? (
                <span className="rounded border border-glass-border bg-deep-black-light px-2 py-0.5 text-xs text-text-secondary">
                  +{selectedOptions.length - 3}
                </span>
              ) : null}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-text-secondary">{selectedLabel(selectedOptions.length)}</span>
          <ChevronDown className={`h-4 w-4 text-text-secondary transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open ? (
        <div
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
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors ${
                          selected ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-primary hover:bg-glass-bg"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
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
