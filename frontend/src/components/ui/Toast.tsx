/**
 * [INPUT]: 订阅 store/useToastStore 的 toast 队列，依赖 useLanguage 决定关闭按钮文案、VI 颜色语义类、styles/ui-motion-interactive.css 的 .bc-toast、lucide 图标与 clsx
 * [OUTPUT]: 对外提供 Toaster（默认导出，全局宿主）与 toast()（命令式入口，转自 useToastStore）
 * [POS]: 在 RootLayout body 末尾挂载一次；右下角（移动端底部居中）最多 3 条，可手动关闭，替代散落的自制轻提示
 * [PROTOCOL]: 与 store/useToastStore.ts 成对维护；danger 用 role="alert"，其余 role="status"；动效以 VI.md §8 为准
 */
"use client";

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { clsx } from "clsx";
import { useLanguage } from "@/lib/i18n";
import { useToastStore } from "@/store/useToastStore";
import type { ToastItem, ToastTone } from "@/store/useToastStore";

export { toast } from "@/store/useToastStore";
export type { ToastOptions, ToastTone } from "@/store/useToastStore";

const TONE: Record<ToastTone, { icon: LucideIcon; className: string }> = {
  neutral: { icon: Info, className: "text-text-secondary" },
  success: { icon: CheckCircle2, className: "text-success" },
  warning: { icon: AlertTriangle, className: "text-warning" },
  danger: { icon: XCircle, className: "text-danger" },
};

const CLOSE_LABEL = { en: "Dismiss", zh: "关闭" } as const;

function ToastCard({ item, closeLabel, onDismiss }: { item: ToastItem; closeLabel: string; onDismiss: () => void }) {
  const { icon: Icon, className: toneClass } = TONE[item.tone];
  return (
    <div
      role={item.tone === "danger" ? "alert" : "status"}
      data-state={item.leaving ? "closed" : "open"}
      data-tone={item.tone}
      className={clsx(
        "bc-toast pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-border bg-surface-raised p-3",
        "text-text-primary shadow-[var(--bc-shadow-lg)]",
      )}
    >
      <Icon aria-hidden className={clsx("mt-0.5 h-4 w-4 shrink-0", toneClass)} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{item.title}</div>
        {item.description != null ? <div className="mt-0.5 text-xs text-text-secondary">{item.description}</div> : null}
        {item.action ? (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              onDismiss();
            }}
            className={clsx(
              "mt-2 rounded-lg text-xs font-medium text-accent-text hover:text-accent-hover",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60",
            )}
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onDismiss}
        className={clsx(
          "bc-touch-target -m-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-text-tertiary",
          "transition-colors duration-[var(--bc-duration-fast)] hover:bg-surface-sunken hover:text-text-primary motion-reduce:transition-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60",
        )}
      >
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function Toaster({ className }: { className?: string }) {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const locale = useLanguage();

  if (toasts.length === 0) return null;
  return (
    <div
      className={clsx(
        "pointer-events-none fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[90] mx-auto flex max-w-sm flex-col gap-2",
        "sm:inset-x-auto sm:right-4 sm:mx-0 sm:w-96",
        className,
      )}
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} closeLabel={CLOSE_LABEL[locale]} onDismiss={() => dismiss(item.id)} />
      ))}
    </div>
  );
}

export { Toaster };
