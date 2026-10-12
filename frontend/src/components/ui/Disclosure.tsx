/**
 * [INPUT]: Native details attributes and a summary label
 * [OUTPUT]: Disclosure: keyboard-accessible expandable content
 * [POS]: UI disclosure primitive; callers own open when controlled
 * [PROTOCOL]: Preserve native details semantics and onToggle
 */
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "clsx";
export interface DisclosureProps extends Omit<ComponentPropsWithoutRef<"details">, "title"> { title: ReactNode }
export default function Disclosure({ title, children, className, ...props }: DisclosureProps) {
  return <details {...props} className={clsx("group rounded-xl border border-border bg-surface px-4 py-3", className)}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-sm font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [&::-webkit-details-marker]:hidden">
      {title}<ChevronDown aria-hidden className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="pt-3 text-sm text-text-secondary">{children}</div>
  </details>;
}
