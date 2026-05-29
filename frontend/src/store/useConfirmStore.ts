/**
 * [INPUT]: 依赖 zustand 维护全局唯一的确认/提示请求队列槽位
 * [OUTPUT]: 对外提供 useConfirmStore（原子状态）与 useConfirm hook（promise-based 调用入口）
 * [POS]: 全局确认对话框的状态中枢，取代散落各处的 window.confirm / window.alert
 * [PROTOCOL]: 与 components/ui/ConfirmDialog.tsx（渲染宿主）成对维护，变更选项字段时两侧同步
 */
"use client";

import { useCallback } from "react";
import { create } from "zustand";

export type ConfirmTone = "default" | "danger";

export interface ConfirmOptions {
  /** 主标题，必填。 */
  title: string;
  /** 可选的补充说明，渲染在标题下方。 */
  message?: string;
  /** 确认按钮文案，缺省按语言回退为「确认 / Confirm」（alert 模式下为「知道了 / OK」）。 */
  confirmLabel?: string;
  /** 取消按钮文案，缺省按语言回退为「取消 / Cancel」。 */
  cancelLabel?: string;
  /** danger 时确认按钮使用红色危险样式。 */
  tone?: ConfirmTone;
  /** 单按钮告知模式（取代 window.alert），仅展示确认按钮。 */
  alert?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface ConfirmState {
  current: ConfirmRequest | null;
  open: (request: ConfirmRequest) => void;
  /** 关闭当前对话框并回传结果（确认 true / 取消 false）。 */
  close: (result: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  open: (request) => {
    // 若已有未决请求，先以「取消」结算，避免 promise 悬挂。
    const previous = get().current;
    if (previous) previous.resolve(false);
    set({ current: request });
  },
  close: (result) => {
    const request = get().current;
    if (request) request.resolve(result);
    set({ current: null });
  },
}));

/**
 * Promise-based 确认入口。用法：
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "删除此 Agent？", tone: "danger" }))) return;
 * alert 形式：await confirm({ title: "提交成功", alert: true });
 */
export function useConfirm() {
  const open = useConfirmStore((s) => s.open);
  return useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        open({ ...options, resolve });
      }),
    [open],
  );
}
