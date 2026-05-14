"use client";

import { Copy, X } from "lucide-react";

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

export default function RuntimeErrorDetailsDialog({
  title = "Runtime error",
  message,
  code,
  payload,
  onClose,
}: RuntimeErrorDetailsDialogProps) {
  const raw = prettyJson(payload);
  const copyText = [
    title,
    code ? `Code: ${code}` : null,
    message ? `Message: ${message}` : null,
    raw ? `Payload:\n${raw}` : null,
  ].filter(Boolean).join("\n\n");

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-amber-400/25 bg-zinc-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-amber-400/15 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-amber-200">{title}</h2>
            {code ? <p className="mt-0.5 font-mono text-xs text-amber-300/70">{code}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">Message</p>
            <div className="whitespace-pre-wrap break-words rounded-lg border border-amber-400/15 bg-amber-400/10 px-3 py-2 text-sm leading-relaxed text-amber-100">
              {message || "Runtime error"}
            </div>
          </div>

          <details className="group">
            <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-zinc-500 transition-colors hover:text-zinc-300">
              Raw payload
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-black/40 p-3 text-xs leading-relaxed text-zinc-300">
              {raw}
            </pre>
          </details>
        </div>

        <div className="flex justify-end gap-2 border-t border-amber-400/15 px-4 py-3">
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(copyText)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy details
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-400/20"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
