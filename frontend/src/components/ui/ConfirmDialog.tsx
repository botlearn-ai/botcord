/**
 * [INPUT]: 订阅 useConfirmStore 的当前请求，依赖 useLanguage 决定按钮文案语言
 * [OUTPUT]: 全局唯一的主题化确认/提示对话框宿主，挂载一次即覆盖全站 window.confirm/alert 场景
 * [POS]: 在 RootLayout body 末尾挂载，是 marketing 与 dashboard 共用的确认弹窗出口
 * [PROTOCOL]: 与 store/useConfirmStore.ts 成对维护，新增选项字段时两侧同步
 */
"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { confirmDialog } from "@/lib/i18n/translations/common";
import { useConfirmStore } from "@/store/useConfirmStore";
import Button from "./Button";
import DialogShell from "./DialogShell";

export default function ConfirmDialog() {
  const current = useConfirmStore((s) => s.current);
  const close = useConfirmStore((s) => s.close);
  const locale = useLanguage();
  const t = confirmDialog[locale];
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  // Result reported once the exit motion finishes; Esc / scrim / X keep the
  // default (cancel, or "ok" in alert mode), the confirm button sets true.
  const resultRef = useRef(false);
  // Remount DialogShell per request so a request that replaces an open one
  // never inherits the previous dialog's closing state.
  const requestKeyRef = useRef<{ request: unknown; key: number }>({ request: null, key: 0 });

  const isAlert = current?.alert ?? false;
  const isDanger = current?.tone === "danger";

  if (current && requestKeyRef.current.request !== current) {
    requestKeyRef.current = { request: current, key: requestKeyRef.current.key + 1 };
  }

  // 每个新请求重置默认结果，并把焦点移到主操作按钮（DialogShell 负责 Esc 关闭）。
  useEffect(() => {
    if (!current) return;
    resultRef.current = isAlert;
    confirmButtonRef.current?.focus();
  }, [current, isAlert]);

  if (!current) return null;

  const confirmLabel =
    current.confirmLabel ?? (isAlert ? t.ok : t.confirm);
  const cancelLabel = current.cancelLabel ?? t.cancel;

  return (
    <DialogShell
      key={requestKeyRef.current.key}
      role="alertdialog"
      title={current.title}
      description={
        current.message ? <span className="whitespace-pre-line">{current.message}</span> : undefined
      }
      icon={isDanger ? <AlertTriangle className="h-5 w-5 shrink-0 text-danger" /> : undefined}
      onClose={() => close(resultRef.current)}
      closeLabel={cancelLabel}
      overlayClassName="z-[1100]"
      footer={(dismiss) => (
        <>
          {isAlert ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                resultRef.current = false;
                dismiss();
              }}
            >
              {cancelLabel}
            </Button>
          )}
          <Button
            ref={confirmButtonRef}
            variant={isDanger ? "danger" : "primary"}
            size="sm"
            onClick={() => {
              resultRef.current = true;
              dismiss();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    />
  );
}
