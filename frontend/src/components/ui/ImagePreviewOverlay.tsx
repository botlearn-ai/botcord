"use client";

import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";

interface ImagePreviewOverlayProps {
  src: string;
  title: string;
  onClose: () => void;
  onImageError: () => void;
  currentIndex?: number;
  totalCount?: number;
  onPrevious?: () => void;
  onNext?: () => void;
}

export default function ImagePreviewOverlay({
  src,
  title,
  onClose,
  onImageError,
  currentIndex,
  totalCount,
  onPrevious,
  onNext,
}: ImagePreviewOverlayProps) {
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const canGoPrevious = Boolean(onPrevious);
  const canGoNext = Boolean(onNext);
  const hasGallery = typeof currentIndex === "number" && typeof totalCount === "number" && totalCount > 1;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" && onPrevious) {
        event.preventDefault();
        onPrevious();
      } else if (event.key === "ArrowRight" && onNext) {
        event.preventDefault();
        onNext();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, onNext, onPrevious]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!hasGallery || (event.pointerType === "mouse" && event.button !== 0)) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start) return;

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaY) > 80 || Math.abs(deltaY) > Math.abs(deltaX)) return;
    if (deltaX > 0) {
      onPrevious?.();
    } else {
      onNext?.();
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[9999] flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        pointerStartRef.current = null;
      }}
    >
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-glass-border bg-deep-black/85 px-3 py-2 sm:px-5">
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium text-text-primary">{title}</span>
          {hasGallery && (
            <span className="block text-[11px] text-text-secondary/70">
              {currentIndex + 1} / {totalCount}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
            aria-label="Open original image"
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
            aria-label="Close image preview"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-6">
        {hasGallery && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPrevious?.();
            }}
            disabled={!canGoPrevious}
            className="absolute left-3 top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/55 text-text-primary shadow-lg transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30 sm:inline-flex"
            aria-label="Previous image"
            title="Previous image"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        <img
          src={src}
          alt={title}
          className="max-h-[calc(100vh-6.5rem)] max-w-full object-contain shadow-2xl"
          onError={onImageError}
        />
        {hasGallery && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onNext?.();
            }}
            disabled={!canGoNext}
            className="absolute right-3 top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/55 text-text-primary shadow-lg transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30 sm:inline-flex"
            aria-label="Next image"
            title="Next image"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
