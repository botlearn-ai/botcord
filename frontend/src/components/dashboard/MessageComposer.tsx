"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { FileText, Paperclip, Send, X } from "lucide-react";

interface PendingFile {
  file: File;
  preview?: string;
}

interface MessageComposerProps {
  onSend: (text: string, files: File[]) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  allowAttachments?: boolean;
  maxFiles?: number;
  emptyState?: boolean;
  autoFocus?: boolean;
}

export default function MessageComposer({
  onSend,
  disabled = false,
  placeholder = "Type a message...",
  allowAttachments = false,
  maxFiles = 10,
  emptyState = false,
  autoFocus = false,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      setFiles((prev) => {
        for (const f of prev) { if (f.preview) URL.revokeObjectURL(f.preview); }
        return [];
      });
    };
  }, []);

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const addFiles = useCallback((list: FileList | null) => {
    if (!list || list.length === 0 || !allowAttachments) return;
    setFiles((prev) => {
      const remaining = maxFiles - prev.length;
      if (remaining <= 0) return prev;
      const toAdd = Array.from(list).slice(0, remaining);
      const next: PendingFile[] = toAdd.map((file) => ({
        file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      }));
      return [...prev, ...next];
    });
  }, [allowAttachments, maxFiles]);

  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => {
      const removed = prev[idx];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    const hasFiles = files.length > 0;
    if ((!trimmed && !hasFiles) || disabled) return;

    const raw = files.map((pf) => pf.file);
    for (const pf of files) { if (pf.preview) URL.revokeObjectURL(pf.preview); }
    setText("");
    setFiles([]);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }

    await onSend(trimmed, raw);
  }, [text, files, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleDrop = useCallback((e: DragEvent) => {
    if (!allowAttachments) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }, [allowAttachments, addFiles]);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (allowAttachments) e.preventDefault();
  }, [allowAttachments]);

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const canSend = !disabled && (text.trim().length > 0 || files.length > 0);

  return (
    <div onDrop={handleDrop} onDragOver={handleDragOver}>
      {allowAttachments && files.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {files.map((pf, idx) => (
            <div
              key={idx}
              className="relative group flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-300 max-w-[200px]"
            >
              {pf.preview ? (
                <img src={pf.preview} alt={pf.file.name} className="w-8 h-8 rounded object-cover shrink-0" />
              ) : (
                <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
              )}
              <span className="truncate">{pf.file.name}</span>
              <button
                type="button"
                onClick={() => removeFile(idx)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-600 text-zinc-200 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
                aria-label="Remove attachment"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {allowAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center w-9 h-9 rounded-lg text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 transition-colors"
              title="Attach file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          className={`flex-1 bg-zinc-900 border rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:border-cyan-500/50 transition-all ${
            emptyState
              ? "border-cyan-500/40 shadow-[0_0_8px_rgba(0,240,255,0.1)] animate-[pulse-border_2s_ease-in-out_infinite]"
              : "border-zinc-700"
          }`}
          placeholder={placeholder}
          value={text}
          onChange={(e) => { setText(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          className="flex items-center justify-center w-9 h-9 rounded-lg bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label="Send message"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
