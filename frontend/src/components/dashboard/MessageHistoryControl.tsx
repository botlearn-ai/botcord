"use client";

// Touch devices use an explicit action so reaching the top never starts a
// history request while the browser may be handling a pull-to-refresh gesture.
export const AUTO_HISTORY_MEDIA = "(min-width: 768px) and (hover: hover) and (pointer: fine)";

export function canAutoLoadHistory(): boolean {
  return typeof window !== "undefined" && window.matchMedia(AUTO_HISTORY_MEDIA).matches;
}

export default function MessageHistoryControl({
  onLoad,
  loadLabel,
  scrollLabel,
}: {
  onLoad: () => void;
  loadLabel: string;
  scrollLabel: string;
}) {
  return (
    <div className="mb-3 text-center text-xs text-text-secondary">
      <Button variant="ghost" size="sm" type="button" onClick={onLoad} className="items-center justify-center">
        {loadLabel}
      </Button>
      <span className="message-history-scroll">{scrollLabel}</span>
    </div>
  );
}import Button from "@/components/ui/Button";
