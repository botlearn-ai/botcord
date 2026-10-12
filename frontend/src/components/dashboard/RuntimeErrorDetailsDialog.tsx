"use client";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useRef } from "react";
import { Copy } from "lucide-react";
import { animatePop, cleanupAnime } from "@/lib/anime";
import Disclosure from "@/components/ui/Disclosure";
import Button from "@/components/ui/Button";
import DialogShell from "@/components/ui/DialogShell";

interface RuntimeErrorDetailsDialogProps {
  title?: string;
  message: string;
  code?: string | null;
  payload?: unknown;
  onClose: () => void;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? "");
  }
}

export default withDashboardOverlayPortal(RuntimeErrorDetailsDialog, "nested");

function RuntimeErrorDetailsDialog({
  title = "Runtime error",
  message,
  code,
  payload,
  onClose,
}: RuntimeErrorDetailsDialogProps) {
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const copyAnimationRef = useRef<ReturnType<typeof animatePop>>(null);
  const raw = prettyJson(payload);
  const copyText = [
    title,
    code ? `Code: ${code}` : null,
    message ? `Message: ${message}` : null,
    raw ? `Payload:\n${raw}` : null,
  ].filter(Boolean).join("\n\n");

  return (
    <DialogShell
      title={<span className="truncate text-warning">{title}</span>}
      description={code ? <span className="font-mono text-xs text-warning/80">{code}</span> : undefined}
      size="lg"
      onClose={onClose}
      overlayClassName="z-[80] backdrop-blur-sm"
      className="border-warning/25"
      bodyClassName="space-y-4"
      footer={(close) => (
        <>
          <Button
            ref={copyButtonRef}
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(copyText);
              if (copyButtonRef.current) {
                cleanupAnime(copyAnimationRef.current);
                copyAnimationRef.current = animatePop(copyButtonRef.current);
              }
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy details
          </Button>
          <Button variant="secondary" size="sm" onClick={close}>
            Close
          </Button>
        </>
      )}
    >
      <div>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-secondary">Message</p>
        <div className="whitespace-pre-wrap break-words rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-sm leading-relaxed text-warning">
          {message || "Runtime error"}
        </div>
      </div>

      <Disclosure title="Raw payload">
        <pre className="liquid-tool-surface mt-2 max-h-64 overflow-auto rounded-lg border p-3 text-xs leading-relaxed text-text-primary">
          {raw}
        </pre>
      </Disclosure>
    </DialogShell>
  );
}
