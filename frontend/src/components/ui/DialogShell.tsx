"use client";

/**
 * [INPUT]: 依赖 lib/anime 的 overlay 进出场动效、全局 liquid-scrim / liquid-dialog 样式与 lucide X
 * [OUTPUT]: 对外提供 DialogShell 与 useDialogClose：统一遮罩、面板、标题区、底栏、Esc / 遮罩关闭与退场动画；
 *           overlayClassName 里的 z-* 替换默认 z-[110]，className 里的 max-w-* 替换 size 预设，role / closeLabel 可覆盖
 * [POS]: ui 弹窗原语。dashboard 弹窗仍用 withDashboardOverlayPortal 包一层负责全局叠放；本组件只管弹窗本身
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；样式规则以 docs/brand/botcord-vi/VI.md §8、§9 为准
 */

import { Children, createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { clsx } from "clsx";
import IconButton from "./IconButton";
import { X } from "lucide-react";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";

type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

// Unprefixed utility check (ignores variants such as sm:max-w-*), so a caller's
// override never competes with the default class in the same element.
function hasUtility(classes: string | undefined, prefix: string): boolean {
  return Boolean(classes?.split(/\s+/).some((name) => name.startsWith(prefix)));
}

let openDialogCount = 0;
let originalBodyOverflow = "";

const DialogCloseContext = createContext<() => void>(() => {});

/** Close the surrounding DialogShell with its exit animation (e.g. after a successful submit). */
export function useDialogClose(): () => void {
  return useContext(DialogCloseContext);
}

export interface DialogShellProps {
  placement?: "center" | "right";
  title: ReactNode;
  description?: ReactNode;
  /** Icon shown before the title. */
  icon?: ReactNode;
  size?: DialogSize;
  /** While busy the dialog cannot be dismissed (Esc, scrim, close button). */
  busy?: boolean;
  /** Called after the exit animation finishes. */
  onClose: () => void;
  /** Footer actions, right-aligned. Receives the animated close function. */
  footer?: ReactNode | ((close: () => void) => ReactNode);
  /** Hide the top-right close button (e.g. when the footer has its own cancel). */
  hideCloseButton?: boolean;
  /** Accessible label of the top-right close button. Defaults to "Close". */
  closeLabel?: string;
  /** Use "alertdialog" for confirmations that interrupt the user. */
  role?: "dialog" | "alertdialog";
  /** Extra scrim classes. A z-* class here replaces the default z-[110]. */
  overlayClassName?: string;
  /** Extra panel classes. A max-w-* class here replaces the size preset. */
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export default function DialogShell({
  title,
  description,
  icon,
  size = "md",
  placement = "center",
  busy = false,
  onClose,
  footer,
  hideCloseButton = false,
  closeLabel = "Close",
  role = "dialog",
  overlayClassName,
  className,
  bodyClassName,
  children,
}: DialogShellProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

  const close = useCallback(() => {
    if (busy || closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [busy, closing, onClose]);

  // Bypasses the busy guard so a finished submit can dismiss the dialog.
  const closeAfterSubmit = useCallback(() => {
    if (closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (openDialogCount++ === 0) { originalBodyOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, {
      // An identity transform still traps fixed descendants in this panel.
      onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
    });
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      cleanupAnime(animationRef.current);
      if (--openDialogCount === 0) document.body.style.overflow = originalBodyOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const panel = panelRef.current;
      const nativeModal = document.querySelector("dialog[open]");
      if (!panel || (nativeModal && !panel.contains(nativeModal))) return;
      const modals = [...document.querySelectorAll('[aria-modal="true"]')];
      if (modals.at(-1) !== panel) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); panel.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close]);

  // Conditional children (e.g. `{invite && …}`) can render nothing; skip the padded body then.
  const hasBody = Children.toArray(children).length > 0;

  return (
    <DialogCloseContext.Provider value={closeAfterSubmit}>
      <div
        ref={overlayRef}
        className={clsx(
          "liquid-scrim fixed inset-0 flex",
          placement === "right" ? "items-stretch justify-end" : "items-center justify-center p-4",
          hasUtility(overlayClassName, "z-") ? null : "z-[110]",
          overlayClassName,
          closing && "pointer-events-none",
        )}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div
          ref={panelRef}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className={clsx(
            "liquid-dialog relative flex w-full flex-col outline-none",
            placement === "right" ? "h-dvh border-l border-border pb-[env(safe-area-inset-bottom)]" : "max-h-[90dvh] rounded-2xl",
            hasUtility(className, "max-w-") ? null : SIZE[size],
            className,
          )}
        >
          <div className={clsx("px-5 pt-5", hideCloseButton ? "" : "pr-16")}>
            <h3 id={titleId} className="flex items-center gap-2 break-words text-lg font-semibold tracking-[-0.01em] text-text-primary">
              {icon}
              {title}
            </h3>
            {description ? <p id={descriptionId} className="mt-1.5 break-words text-sm text-text-secondary">{description}</p> : null}
          </div>
          {hideCloseButton ? null : (
            <IconButton
              size="sm"
              onClick={close}
              disabled={busy}
              label={closeLabel}
              className="absolute right-4 top-4"
            >
              <X className="h-5 w-5" />
            </IconButton>
          )}
          {hasBody ? (
            <div className={clsx("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4", bodyClassName)}>{children}</div>
          ) : (
            <div className="pb-4" />
          )}
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3.5">
              {typeof footer === "function" ? footer(close) : footer}
            </div>
          ) : null}
        </div>
      </div>
    </DialogCloseContext.Provider>
  );
}
