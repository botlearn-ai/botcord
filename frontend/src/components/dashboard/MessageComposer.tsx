"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { FileText, Paperclip, Send, X } from "lucide-react";

interface PendingFile {
  file: File;
  preview?: string;
}

export interface MentionCandidate {
  agent_id: string;
  display_name: string;
  /** When set, inserted as @display_name(id) so the AI can resolve the exact target. */
  id?: string;
}

interface MentionMatch {
  start: number;
  query: string;
}

interface MessageComposerProps {
  onSend: (text: string, files: File[], mentions?: string[]) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  allowAttachments?: boolean;
  maxFiles?: number;
  emptyState?: boolean;
  autoFocus?: boolean;
  mentionCandidates?: MentionCandidate[];
  /** Pre-fill the composer with this text (e.g. forwarded quote). Triggers autoFocus. */
  initialText?: string;
}

const MAX_SUGGESTIONS = 8;

function detectMention(text: string, cursor: number): MentionMatch | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "@") {
      const prev = i > 0 ? text[i - 1] : " ";
      if (i === 0 || prev === " " || prev === "\n" || prev === "\t") {
        return { start: i, query: text.slice(i + 1, cursor) };
      }
      return null;
    }
    if (c === " " || c === "\n" || c === "\t") return null;
  }
  return null;
}

// Boundary-aware check: returns true only when "@<displayName>" appears in text
// followed by a word boundary (whitespace, punctuation, or end-of-string).
// Without this, "@Alice" would be incorrectly detected inside "@AliceX".
function textHasMention(text: string, displayName: string): boolean {
  const needle = `@${displayName}`;
  let idx = 0;
  while (true) {
    const found = text.indexOf(needle, idx);
    if (found === -1) return false;
    const after = text[found + needle.length];
    if (after === undefined || /[\s.,!?;:)\]}'"]/.test(after)) return true;
    idx = found + needle.length;
  }
}

export default function MessageComposer({
  onSend,
  disabled = false,
  placeholder = "Type a message...",
  allowAttachments = false,
  maxFiles = 10,
  emptyState = false,
  autoFocus = false,
  mentionCandidates,
  initialText,
}: MessageComposerProps) {
  const [text, setText] = useState(initialText ?? "");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pickedMentions, setPickedMentions] = useState<MentionCandidate[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mentionEnabled = !!mentionCandidates && mentionCandidates.length > 0;

  useEffect(() => {
    if (!autoFocus && !initialText) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [autoFocus, initialText]);

  useEffect(() => {
    if (!initialText) return;
    setText(initialText);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [initialText]);

  useEffect(() => {
    return () => {
      setFiles((prev) => {
        for (const f of prev) { if (f.preview) URL.revokeObjectURL(f.preview); }
        return [];
      });
    };
  }, []);

  const suggestions = useMemo<MentionCandidate[]>(() => {
    if (!mentionEnabled || !mentionMatch || !mentionCandidates) return [];
    const q = mentionMatch.query.toLowerCase();
    return mentionCandidates
      .filter((c) => c.display_name.toLowerCase().includes(q) || c.agent_id.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
  }, [mentionEnabled, mentionMatch, mentionCandidates]);

  useEffect(() => {
    if (mentionIndex >= suggestions.length) setMentionIndex(0);
  }, [suggestions.length, mentionIndex]);

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const updateMentionMatch = useCallback(() => {
    const el = inputRef.current;
    if (!mentionEnabled || !el) { setMentionMatch(null); return; }
    const cursor = el.selectionStart ?? el.value.length;
    setMentionMatch(detectMention(el.value, cursor));
  }, [mentionEnabled]);

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

  const commitMention = useCallback((candidate: MentionCandidate) => {
    const el = inputRef.current;
    if (!el || !mentionMatch) return;
    const cursor = el.selectionStart ?? el.value.length;
    const before = text.slice(0, mentionMatch.start);
    const after = text.slice(cursor);
    const insert = candidate.id
      ? `@${candidate.display_name}(${candidate.id}) `
      : `@${candidate.display_name} `;
    const next = `${before}${insert}${after}`;
    setText(next);
    setMentionMatch(null);
    setPickedMentions((prev) => {
      if (prev.some((m) => m.agent_id === candidate.agent_id)) return prev;
      return [...prev, candidate];
    });
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      const pos = before.length + insert.length;
      node.focus();
      node.setSelectionRange(pos, pos);
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
    });
  }, [mentionMatch, text]);

  const activeMentions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of pickedMentions) {
      if (seen.has(m.agent_id)) continue;
      if (!textHasMention(text, m.display_name)) continue;
      seen.add(m.agent_id);
      out.push(m.agent_id);
    }
    const allMention = mentionCandidates?.find((m) => m.agent_id === "@all");
    if (allMention && !seen.has(allMention.agent_id) && textHasMention(text, allMention.display_name)) {
      out.push(allMention.agent_id);
    }
    return out;
  }, [pickedMentions, text, mentionCandidates]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    const hasFiles = files.length > 0;
    if ((!trimmed && !hasFiles) || disabled) return;

    const raw = files.map((pf) => pf.file);
    for (const pf of files) { if (pf.preview) URL.revokeObjectURL(pf.preview); }
    const mentions = activeMentions.slice();
    setText("");
    setFiles([]);
    setPickedMentions([]);
    setMentionMatch(null);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }

    await onSend(trimmed, raw, mentions.length > 0 ? mentions : undefined);
  }, [text, files, disabled, activeMentions, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMatch && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (!e.nativeEvent.isComposing) {
          e.preventDefault();
          const pick = suggestions[mentionIndex] ?? suggestions[0];
          if (pick) commitMention(pick);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMatch(null);
        return;
      }
    }
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
      <div className="relative flex items-end gap-2">
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
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
            updateMentionMatch();
          }}
          onKeyUp={updateMentionMatch}
          onClick={updateMentionMatch}
          onBlur={() => setTimeout(() => setMentionMatch(null), 120)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
        />
        {mentionMatch && suggestions.length > 0 && (
          <div
            className="absolute left-0 right-12 bottom-full mb-1 z-20 max-h-56 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
            role="listbox"
          >
            {suggestions.map((s, i) => (
              <button
                type="button"
                key={s.agent_id}
                role="option"
                aria-selected={i === mentionIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitMention(s);
                }}
                onMouseEnter={() => setMentionIndex(i)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  i === mentionIndex
                    ? "bg-cyan-500/15 text-cyan-200"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <span className="truncate font-medium">{s.display_name}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">{s.id ?? s.agent_id}</span>
              </button>
            ))}
          </div>
        )}
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
