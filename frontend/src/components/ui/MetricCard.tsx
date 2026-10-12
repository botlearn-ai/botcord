/**
 * [INPUT]: A value, a label and optional supporting detail
 * [OUTPUT]: Consistent numeric summary using semantic dl/dt/dd
 * [POS]: UI metric primitive; calculation and formatting remain caller-owned
 * [PROTOCOL]: Keep data semantics separate from presentation
 */
import type { ReactNode } from "react";
import { clsx } from "clsx";
export default function MetricCard({ value, label, detail, accent = false, className }: { value: ReactNode; label: ReactNode; detail?: ReactNode; accent?: boolean; className?: string }) {
  return <dl className={clsx("flex flex-col rounded-xl border border-border bg-surface p-3", className)}>
    <dt className="order-2 mt-0.5 text-xs text-text-secondary">{label}</dt>
    <dd className={clsx("order-1 text-xl font-semibold tabular-nums", accent ? "text-accent-text" : "text-text-primary")}>{value}</dd>
    {detail ? <dd className="order-3 mt-2 text-xs text-text-secondary">{detail}</dd> : null}
  </dl>;
}
