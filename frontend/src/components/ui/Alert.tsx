/**
 * [INPUT]: Semantic tone (accent = needs your action), optional heading, icon and actions
 * [OUTPUT]: Persistent inline message; danger announces urgently, other tones politely
 * [POS]: UI feedback primitive; transient notifications use Toast
 * [PROTOCOL]: Keep the public API aligned with COMPONENTS.md
 */
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { AlertTriangle, CheckCircle2, Info, CircleAlert } from "lucide-react";
import { clsx } from "clsx";
export type AlertTone = "neutral" | "accent" | "success" | "warning" | "danger";
export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> { ref?: Ref<HTMLDivElement>; tone?: AlertTone; title?: ReactNode; icon?: ReactNode; actions?: ReactNode }
const tones = {
  neutral: "border-border bg-surface-sunken text-text-primary",
  accent: "border-accent/30 bg-accent-soft text-text-primary",
  success: "border-success/30 bg-success-soft text-success",
  warning: "border-warning/30 bg-warning-soft text-warning",
  danger: "border-danger/30 bg-danger-soft text-danger",
};
const icons = { neutral: Info, accent: Info, success: CheckCircle2, warning: AlertTriangle, danger: CircleAlert };
export default function Alert({ tone = "neutral", title, icon, actions, children, className, role, ...props }: AlertProps) {
  const Icon = icons[tone];
  return <div {...props} role={role ?? (tone === "danger" ? "alert" : "status")} className={clsx("flex items-start gap-3 rounded-xl border p-3 text-sm", tones[tone], className)}>
    <span aria-hidden className={clsx("mt-0.5 inline-flex shrink-0 [&>svg]:h-4 [&>svg]:w-4", tone === "accent" && "text-accent-text")}>{icon ?? <Icon />}</span>
    <div className="min-w-0 flex-1 break-words">{title ? <div className="font-semibold">{title}</div> : null}{children ? <div className={clsx(title && "mt-1")}>{children}</div> : null}</div>
    {actions ? <div className="shrink-0">{actions}</div> : null}
  </div>;
}
