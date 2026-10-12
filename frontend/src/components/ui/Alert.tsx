/**
 * [INPUT]: Semantic tone, optional heading and actions
 * [OUTPUT]: Persistent inline message; danger announces urgently, other tones politely
 * [POS]: UI feedback primitive; transient notifications use Toast
 * [PROTOCOL]: Keep the public API aligned with COMPONENTS.md
 */
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { AlertTriangle, CheckCircle2, Info, CircleAlert } from "lucide-react";
import { clsx } from "clsx";
export type AlertTone = "neutral" | "success" | "warning" | "danger";
export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> { ref?: Ref<HTMLDivElement>; tone?: AlertTone; title?: ReactNode; actions?: ReactNode }
const tones = {
  neutral: "border-border bg-surface-sunken text-text-primary",
  success: "border-success/30 bg-success-soft text-success",
  warning: "border-warning/30 bg-warning-soft text-warning",
  danger: "border-danger/30 bg-danger-soft text-danger",
};
const icons = { neutral: Info, success: CheckCircle2, warning: AlertTriangle, danger: CircleAlert };
export default function Alert({ tone = "neutral", title, actions, children, className, role, ...props }: AlertProps) {
  const Icon = icons[tone];
  return <div {...props} role={role ?? (tone === "danger" ? "alert" : "status")} className={clsx("flex items-start gap-3 rounded-xl border p-3 text-sm", tones[tone], className)}>
    <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
    <div className="min-w-0 flex-1 break-words">{title ? <div className="font-semibold">{title}</div> : null}{children ? <div className={clsx(title && "mt-1")}>{children}</div> : null}</div>
    {actions ? <div className="shrink-0">{actions}</div> : null}
  </div>;
}
