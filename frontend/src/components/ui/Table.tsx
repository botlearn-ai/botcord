/**
 * [INPUT]: Native table elements; sorting and pagination remain caller-owned
 * [OUTPUT]: Table and semantic head/body/row/cell primitives with VI spacing
 * [POS]: Admin and device data lists; Markdown tables retain document styling
 * [PROTOCOL]: Keep native semantics, colSpan and caption support
 */
import type { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { clsx } from "clsx";
export default function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table {...props} className={clsx("w-full border-collapse text-sm leading-relaxed text-text-primary", className)} />;
}
export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} className={clsx("border-b border-border bg-surface-sunken", className)} />;
}
export function TableBody(props: HTMLAttributes<HTMLTableSectionElement>) { return <tbody {...props} />; }
export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...props} className={clsx("border-b border-border last:border-0", className)} />;
}
export function TableHeader({ className, scope = "col", ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...props} scope={scope} className={clsx("px-4 py-3 text-left type-caption text-text-secondary", className)} />;
}
export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={clsx("px-4 py-3", className)} />;
}
