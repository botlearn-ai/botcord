"use client";

import { ChevronUp } from "lucide-react";
import Button from "@/components/ui/Button";

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
        <span className="inline-flex items-center gap-2 text-accent-text">
          <span aria-hidden="true" className="message-history-arrows relative h-6 w-4 shrink-0">
            {[0, 1, 2].map((index) => (
              <ChevronUp key={index} strokeWidth={1.75} className="message-history-chevron absolute left-0 size-4 motion-reduce:animate-none" />
            ))}
          </span>
          <span>{loadLabel}</span>
        </span>
      </Button>
      <span className="message-history-scroll">{scrollLabel}</span>
    </div>
  );
}
