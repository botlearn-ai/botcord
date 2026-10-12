/**
 * [INPUT]: 依赖 zustand 维护全局 toast 队列与各条的自动关闭计时器
 * [OUTPUT]: 对外提供 useToastStore（原子状态：toasts / show / dismiss / remove）与 toast() 命令式调用入口
 * [POS]: 全局轻提示的状态中枢；渲染宿主是 components/ui/Toast.tsx 的 <Toaster />
 * [PROTOCOL]: 与 components/ui/Toast.tsx 成对维护，变更选项字段时两侧同步；可见条数上限 MAX_VISIBLE_TOASTS
 */
"use client";

import type { ReactNode } from "react";
import { create } from "zustand";

export type ToastTone = "neutral" | "success" | "warning" | "danger";

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  action?: { label: ReactNode; onClick: () => void };
  /** Auto-dismiss delay; non-finite or <= 0 keeps the toast until closed. */
  durationMs?: number;
}

export interface ToastItem extends ToastOptions {
  id: string;
  tone: ToastTone;
  /** true while the exit animation runs; removed after TOAST_EXIT_MS. */
  leaving: boolean;
}

export const MAX_VISIBLE_TOASTS = 3;
export const DEFAULT_TOAST_DURATION_MS = 4000;
/** Matches --bc-duration-base (VI §8) used by the exit animation. */
export const TOAST_EXIT_MS = 220;

interface ToastState {
  toasts: ToastItem[];
  show: (options: ToastOptions) => string;
  /** Starts the exit animation, then removes the toast. */
  dismiss: (id: string) => void;
  remove: (id: string) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let counter = 0;

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: (options) => {
    counter += 1;
    const id = `toast-${counter}`;
    const item: ToastItem = { ...options, id, tone: options.tone ?? "neutral", leaving: false };
    set({ toasts: [...get().toasts, item] });

    // Keep at most MAX_VISIBLE_TOASTS on screen: the oldest ones leave first.
    const visible = get().toasts.filter((t) => !t.leaving);
    for (const old of visible.slice(0, Math.max(0, visible.length - MAX_VISIBLE_TOASTS))) get().dismiss(old.id);

    const duration = options.durationMs ?? DEFAULT_TOAST_DURATION_MS;
    if (Number.isFinite(duration) && duration > 0) {
      timers.set(id, setTimeout(() => get().dismiss(id), duration));
    }
    return id;
  },
  dismiss: (id) => {
    const target = get().toasts.find((t) => t.id === id);
    if (!target || target.leaving) return;
    clearTimer(id);
    set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) });
    timers.set(id, setTimeout(() => get().remove(id), TOAST_EXIT_MS));
  },
  remove: (id) => {
    clearTimer(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/**
 * 命令式入口，可在组件外调用：
 *   toast({ title: "已复制", tone: "success" });
 * 返回 id，可用 useToastStore.getState().dismiss(id) 提前关闭。
 */
export function toast(options: ToastOptions): string {
  return useToastStore.getState().show(options);
}
