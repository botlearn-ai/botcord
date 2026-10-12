"use client";

/**
 * [INPUT]: Caller-owned animation refs/close lifecycle and named modal content
 * [OUTPUT]: Shared unpadded modal surface, focus containment, Escape and scroll lock
 * [POS]: Advanced composition for existing animated business dialogs; prefer DialogShell for new forms
 * [PROTOCOL]: Does not start animations; caller must remove identity transforms after enter
 */
import { useId, useRef } from "react";
import type { ReactNode, Ref, RefObject } from "react";
import { clsx } from "clsx";
import { useDialogInteractions } from "./use-dialog-interactions";

export interface DialogSurfaceProps {
  overlayRef?: Ref<HTMLDivElement>;
  panelRef?: RefObject<HTMLDivElement | null>;
  title?: ReactNode;
  ariaLabel?: string;
  onClose: () => void;
  closing?: boolean;
  /** Nonmodal desktop inspectors keep the surrounding workspace interactive. */
  modal?: boolean;
  busy?: boolean;
  placement?: "center" | "right" | "left" | "bottom";
  size?: "sm" | "md" | "lg" | "xl" | "full";
  role?: "dialog" | "alertdialog";
  className?: string;
  overlayClassName?: string;
  children: ReactNode;
}
const sizes = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg", xl: "max-w-2xl", full: "max-w-full" };
export default function DialogSurface({ overlayRef, panelRef: externalRef, title, ariaLabel, onClose, closing = false, busy = false, modal = true, placement = "center", size = "lg", role = "dialog", className, overlayClassName, children }: DialogSurfaceProps) {
  const localRef = useRef<HTMLDivElement>(null);
  const panelRef = externalRef ?? localRef;
  const titleId = useId();
  useDialogInteractions(panelRef, onClose, busy || closing, modal);
  const has = (classes: string | undefined, prefix: string) => classes?.split(/\s+/).some((name) => name.startsWith(prefix));
  return <div ref={overlayRef} className={clsx("liquid-scrim fixed inset-0 flex", !has(overlayClassName, "z-") && "z-[110]", placement === "center" ? "items-center justify-center p-4" : placement === "bottom" ? "items-end justify-center" : placement === "right" ? "items-stretch justify-end" : "items-stretch justify-start", closing && "pointer-events-none", overlayClassName)} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy && !closing) onClose(); }}>
    <div ref={panelRef} role={role} aria-modal={modal || undefined} aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : titleId} aria-busy={busy || undefined} tabIndex={-1} className={clsx("liquid-dialog relative flex w-full flex-col outline-none", placement === "left" || placement === "right" ? "h-dvh pb-[env(safe-area-inset-bottom)]" : "max-h-[90dvh] rounded-2xl", !has(className, "max-w-") && sizes[size], className)}>
      {!ariaLabel && <span id={titleId} className="sr-only">{title}</span>}
      {children}
    </div>
  </div>;
}
