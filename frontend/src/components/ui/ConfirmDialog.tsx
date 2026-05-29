/**
 * [INPUT]: 订阅 useConfirmStore 的当前请求，依赖 useLanguage 决定按钮文案语言
 * [OUTPUT]: 全局唯一的主题化确认/提示对话框宿主，挂载一次即覆盖全站 window.confirm/alert 场景
 * [POS]: 在 RootLayout body 末尾挂载，是 marketing 与 dashboard 共用的确认弹窗出口
 * [PROTOCOL]: 与 store/useConfirmStore.ts 成对维护，新增选项字段时两侧同步
 */
"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { confirmDialog } from "@/lib/i18n/translations/common";
import { useConfirmStore } from "@/store/useConfirmStore";

export default function ConfirmDialog() {
  const current = useConfirmStore((s) => s.current);
  const close = useConfirmStore((s) => s.close);
  const locale = useLanguage();
  const t = confirmDialog[locale];
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const isAlert = current?.alert ?? false;
  const isDanger = current?.tone === "danger";

  // Escape 取消（alert 模式下等同于关闭），并把焦点移到主操作按钮。
  useEffect(() => {
    if (!current) return;
    confirmButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(isAlert);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, close, isAlert]);

  if (!current) return null;

  const confirmLabel =
    current.confirmLabel ?? (isAlert ? t.ok : t.confirm);
  const cancelLabel = current.cancelLabel ?? t.cancel;

  const confirmClasses = isDanger
    ? "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
    : "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20";

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="presentation"
      onClick={() => close(isAlert)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={current.title}
        className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => close(isAlert)}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          aria-label={cancelLabel}
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex gap-3 pr-8">
          {isDanger ? (
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 text-red-300">
              <AlertTriangle className="h-5 w-5" />
            </span>
          ) : null}
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-text-primary">{current.title}</h3>
            {current.message ? (
              <p className="mt-2 whitespace-pre-line text-sm text-text-secondary">
                {current.message}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {isAlert ? null : (
            <button
              type="button"
              onClick={() => close(false)}
              className="rounded-lg border border-glass-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-glass-bg"
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={() => close(true)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
