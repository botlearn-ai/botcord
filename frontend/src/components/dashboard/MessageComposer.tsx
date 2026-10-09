"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import ComposerPopover from "./ComposerPopover";
import { detectMention, hydrateMentionDraft, reconcileDraftMentions, serializeDraftMentions, type DraftMention, type MentionMatch } from "./composer-mentions";
import { shouldSendOnEnter } from "./mobileChat";
import { AtSign, Bot, Coins, FileText, FileUp, Hash, Plus, Send, User, X } from "lucide-react";
import { animateIfMotion, animeStagger, cleanupAnime } from "@/lib/anime";

interface PendingFile {
  file: File;
  preview?: string;
}

export interface MentionCandidate {
  agent_id: string;
  display_name: string;
  /** Serialized as @display_name(id) on send; the editor shows only the name. */
  id?: string;
}

interface MessageComposerProps {
  onSend: (text: string, files: File[], mentions?: string[]) => void | Promise<void>;
  onTransfer?: () => void;
  actionLabels?: {
    add?: string;
    file?: string;
    transfer?: string;
    close?: string;
    mention?: string;
  };
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

const MAX_SUGGESTIONS = 2000;
const MESSAGE_MAX_LENGTH = 8000;
export const MESSAGE_COMPOSER_TEXTAREA_ID_PREFIX = "botcord-conversation-composer";
export const MESSAGE_COMPOSER_TEXTAREA_NAME = "botcord_conversation_body";
export const MESSAGE_COMPOSER_TEXTAREA_AUTOCOMPLETE = "off";
export const MESSAGE_COMPOSER_TEXTAREA_ARIA_AUTOCOMPLETE = "none";

// Boundary-aware check: returns true only when "@<displayName>" appears in text
// followed by a word boundary (whitespace, punctuation, or end-of-string).
// Without this, "@Alice" would be incorrectly detected inside "@AliceX".
export function textHasMention(text: string, displayName: string): boolean {
  const needle = `@${displayName}`;
  let idx = 0;
  while (true) {
    const found = text.indexOf(needle, idx);
    if (found === -1) return false;
    const before = text[found - 1];
    const after = text[found + needle.length];
    if (before && !/[\s，。！？、；：（）([{'"“‘]/.test(before)) { idx = found + needle.length; continue; }
    if (after === undefined || /[\s，。！？、；：（）.,!?;:()\]}'"]/.test(after)) return true;
    idx = found + needle.length;
  }
}

export function isImeComposing(
  event: Pick<globalThis.KeyboardEvent, "isComposing"> & { keyCode?: number },
  compositionActive = false,
): boolean {
  return compositionActive || event.isComposing || event.keyCode === 229;
}

export function getClipboardFiles(
  clipboardData: Pick<DataTransfer, "files" | "items"> | null | undefined,
): File[] {
  if (!clipboardData) return [];

  const files = Array.from(clipboardData.files || []);
  if (files.length > 0) return files;

  return Array.from(clipboardData.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

export function getSendableMessageText(text: string, hasFiles: boolean): string | null {
  if (text.trim().length > 0) return text;
  return hasFiles ? "" : null;
}

export default function MessageComposer({
  onSend,
  onTransfer,
  actionLabels,
  disabled = false,
  placeholder = "Type a message...",
  allowAttachments = false,
  maxFiles = 10,
  emptyState = false,
  autoFocus = false,
  mentionCandidates,
  initialText,
}: MessageComposerProps) {
  const initialDraft = useMemo(() => hydrateMentionDraft(initialText ?? ""), [initialText]);
  const [text, setText] = useState(initialDraft.text);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pickedMentions, setPickedMentions] = useState<DraftMention[]>(initialDraft.mentions);
  const [showLengthError, setShowLengthError] = useState((initialText?.length ?? 0) > MESSAGE_MAX_LENGTH);
  const [inputScrollTop, setInputScrollTop] = useState(0);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const composerRowRef = useRef<HTMLDivElement>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nativeEditRef = useRef<{ before: string; start: number; end: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const mentionOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const sendIconRef = useRef<SVGSVGElement>(null);
  const compositionActiveRef = useRef(false);
  const mentionOpenRef = useRef(false);
  const lengthErrorVisibleRef = useRef(showLengthError);
  const mentionListAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const mentionOptionsAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const inputPulseAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const inputShakeAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const sendButtonAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const sendIconAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);
  const inputId = `${MESSAGE_COMPOSER_TEXTAREA_ID_PREFIX}-${useId().replace(/:/g, "")}`;

  const mentionListId = `${inputId}-mentions`;
  const mentionEnabled = !!mentionCandidates && mentionCandidates.length > 0;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // Native beforeinput includes deletions/replacements; preserve which identical name was edited.
    const captureEdit = () => {
      nativeEditRef.current = { before: input.value, start: input.selectionStart, end: input.selectionEnd };
    };
    input.addEventListener("beforeinput", captureEdit);
    return () => input.removeEventListener("beforeinput", captureEdit);
  }, []);

  useEffect(() => {
    if (!autoFocus && !initialText) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [autoFocus, initialText]);

  useEffect(() => {
    if (!initialText) return;
    setText(initialDraft.text);
    setPickedMentions(initialDraft.mentions);
    setInputScrollTop(0);
    setShowLengthError(initialText.length > MESSAGE_MAX_LENGTH);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [initialText, initialDraft]);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
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

  useEffect(() => {
    mentionOptionRefs.current = mentionOptionRefs.current.slice(0, suggestions.length);
  }, [suggestions.length]);

  useEffect(() => {
    if (!mentionMatch || suggestions.length === 0) return;
    const list = mentionListRef.current?.parentElement;
    const option = mentionOptionRefs.current[mentionIndex];
    if (!list || !option) return;

    const listTop = list.scrollTop;
    const listBottom = listTop + list.clientHeight;
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;

    if (optionTop < listTop) {
      list.scrollTop = optionTop;
    } else if (optionBottom > listBottom) {
      list.scrollTop = optionBottom - list.clientHeight;
    }
  }, [mentionMatch, mentionIndex, suggestions.length]);

  useEffect(() => {
    return () => {
      cleanupAnime(mentionListAnimationRef.current);
      cleanupAnime(mentionOptionsAnimationRef.current);
      cleanupAnime(inputPulseAnimationRef.current);
      cleanupAnime(inputShakeAnimationRef.current);
      cleanupAnime(sendButtonAnimationRef.current);
      cleanupAnime(sendIconAnimationRef.current);
    };
  }, []);

  useEffect(() => {
    const isOpen = !!mentionMatch && suggestions.length > 0;

    if (!isOpen) {
      mentionOpenRef.current = false;
      cleanupAnime(mentionListAnimationRef.current);
      cleanupAnime(mentionOptionsAnimationRef.current);
      mentionListAnimationRef.current = null;
      mentionOptionsAnimationRef.current = null;
      return;
    }

    if (mentionOpenRef.current) return;
    mentionOpenRef.current = true;

    const list = mentionListRef.current;
    if (list) {
      cleanupAnime(mentionListAnimationRef.current);
      mentionListAnimationRef.current = animateIfMotion(list, {
        opacity: [0, 1],
        translateY: [4, 0],
        scale: [0.985, 1],
        duration: 170,
        ease: "out(3)",
      });
    }

    const options = mentionOptionRefs.current
      .filter((node): node is HTMLButtonElement => Boolean(node))
      .slice(0, 12);

    if (options.length > 0) {
      cleanupAnime(mentionOptionsAnimationRef.current);
      mentionOptionsAnimationRef.current = animateIfMotion(options, {
        opacity: [0, 1],
        translateY: [3, 0],
        scale: [0.985, 1],
        delay: animeStagger(14, { start: 30 }),
        duration: 180,
        ease: "out(3)",
      });
    }

    const input = inputRef.current;
    if (input) {
      cleanupAnime(inputPulseAnimationRef.current);
      inputPulseAnimationRef.current = animateIfMotion(input, {
        boxShadow: [
          "0 0 0 rgba(34, 211, 238, 0)",
          "0 0 0 3px rgba(34, 211, 238, 0.12), 0 0 14px rgba(34, 211, 238, 0.18)",
          "0 0 0 rgba(34, 211, 238, 0)",
        ],
        duration: 460,
        ease: "out(3)",
        onComplete: (animation) => {
          cleanupAnime(animation);
          if (inputPulseAnimationRef.current === animation) {
            inputPulseAnimationRef.current = null;
          }
        },
      });
    }
  }, [mentionMatch, suggestions.length]);

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
    const next = detectMention(el.value, cursor);
    setMentionMatch(next);
    setMentionIndex(0);
  }, [mentionEnabled]);

  const addFiles = useCallback((list: FileList | File[] | null) => {
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
    const insert = `@${candidate.display_name} `;
    const next = `${before}${insert}${after}`;
    const nextMentions = [
      ...reconcileDraftMentions(text, next, pickedMentions),
      { ...candidate, start: before.length, end: before.length + insert.length - 1 },
    ].sort((a, b) => a.start - b.start);
    if (serializeDraftMentions(next, nextMentions).length > MESSAGE_MAX_LENGTH) return;
    setText(next);
    setMentionMatch(null);
    setPickedMentions(nextMentions);
    // Keep focus/caret in the selection gesture, including native mobile keyboards.
    el.value = next;
    el.focus({ preventScroll: true });
    const pos = before.length + insert.length;
    el.setSelectionRange(pos, pos);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [mentionMatch, text, pickedMentions]);

  const activeMentions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of pickedMentions) {
      if (seen.has(m.agent_id)) continue;
      seen.add(m.agent_id);
      out.push(m.agent_id);
    }
    const allMention = mentionCandidates?.find((m) => m.agent_id === "@all");
    if (allMention && !seen.has(allMention.agent_id) && textHasMention(text, allMention.display_name)) {
      out.push(allMention.agent_id);
    }
    return out;
  }, [pickedMentions, text, mentionCandidates]);

  const serializedText = useMemo(() => serializeDraftMentions(text, pickedMentions), [text, pickedMentions]);

  const handleSend = useCallback(async () => {
    const hasFiles = files.length > 0;
    const hasLengthError = serializedText.length > MESSAGE_MAX_LENGTH || showLengthError;
    const sendText = getSendableMessageText(serializedText, hasFiles);
    if (sendText === null || disabled || hasLengthError) return;

    const raw = files.map((pf) => pf.file);
    for (const pf of files) { if (pf.preview) URL.revokeObjectURL(pf.preview); }
    const mentions = activeMentions.slice();
    setText("");
    setFiles([]);
    setPickedMentions([]);
    setInputScrollTop(0);
    setMentionMatch(null);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }

    await onSend(sendText, raw, mentions.length > 0 ? mentions : undefined);
  }, [serializedText, files, disabled, showLengthError, activeMentions, onSend]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const composing = isImeComposing(e.nativeEvent, compositionActiveRef.current);
    if (composing) {
      e.stopPropagation();
      return;
    }
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
      if (e.key === "PageDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 8, suggestions.length - 1));
        return;
      }
      if (e.key === "PageUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 8, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (!composing) {
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
    if (shouldSendOnEnter(e.key, e.shiftKey, composing, window.matchMedia("(pointer: coarse)").matches)) {
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
    setActionMenuOpen(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const wouldExceedMaxLength = useCallback((incomingText: string) => {
    const el = inputRef.current;
    if (!el || !incomingText) return false;
    const selectedLength = Math.max(0, (el.selectionEnd ?? 0) - (el.selectionStart ?? 0));
    return text.length - selectedLength + incomingText.length > MESSAGE_MAX_LENGTH;
  }, [text.length]);

  const handleBeforeInput = useCallback((e: FormEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as InputEvent;
    if (wouldExceedMaxLength(nativeEvent.data ?? "")) {
      setShowLengthError(true);
    }
  }, [wouldExceedMaxLength]);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = getClipboardFiles(e.clipboardData);
    if (pastedFiles.length > 0) {
      addFiles(pastedFiles);
    }
    if (wouldExceedMaxLength(e.clipboardData.getData("text"))) {
      setShowLengthError(true);
    }
  }, [addFiles, wouldExceedMaxLength]);

  const hasLengthError = serializedText.length > MESSAGE_MAX_LENGTH || showLengthError;
  const canSend = !disabled && !hasLengthError && (text.trim().length > 0 || files.length > 0);
  const showActionMenu = allowAttachments || !!onTransfer;

  useEffect(() => {
    if (hasLengthError && !lengthErrorVisibleRef.current) {
      const input = inputRef.current;
      if (input) {
        cleanupAnime(inputShakeAnimationRef.current);
        inputShakeAnimationRef.current = animateIfMotion(input, {
          translateX: [0, -4, 4, -3, 3, 0],
          duration: 220,
          ease: "out(3)",
        });
      }
    }
    lengthErrorVisibleRef.current = hasLengthError;
  }, [hasLengthError]);

  const handleSendClick = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
    if (canSend) {
      const button = sendButtonRef.current;
      if (button) {
        cleanupAnime(sendButtonAnimationRef.current);
        sendButtonAnimationRef.current = animateIfMotion(button, {
          scale: [1, 0.97, 1.05, 1],
          duration: 240,
          ease: "out(3)",
        });
      }

      const icon = sendIconRef.current;
      if (icon) {
        cleanupAnime(sendIconAnimationRef.current);
        sendIconAnimationRef.current = animateIfMotion(icon, {
          translateX: [0, 3, 0],
          scale: [1, 0.94, 1.08, 1],
          duration: 240,
          ease: "out(3)",
        });
      }
    }

    void handleSend();
  }, [canSend, handleSend]);

  return (
    <div onDrop={handleDrop} onDragOver={handleDragOver} className="liquid-composer rounded-2xl border border-glass-border p-1.5">
      {hasLengthError && (
        <p className="mb-1 px-1 text-[11px] leading-4 text-red-400">
          Message cannot exceed {MESSAGE_MAX_LENGTH.toLocaleString()} characters.
        </p>
      )}
      {allowAttachments && files.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {files.map((pf, idx) => (
            <div
              key={idx}
              className="relative group flex max-w-[200px] items-center gap-1.5 rounded-xl border border-glass-border bg-deep-black-light px-2 py-1.5 text-xs text-text-primary"
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
                className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-600 text-zinc-200 transition-colors hover:bg-red-500 max-md:h-11 max-md:w-11"
                aria-label="Remove attachment"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div ref={composerRowRef} className="relative flex items-end gap-2 max-md:flex-wrap max-md:gap-0">
        {showActionMenu && (
          <>
            {allowAttachments && (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />
            )}
            <div className="relative">
              {actionMenuOpen && (
                <ComposerPopover anchorRef={composerRowRef} onClose={() => setActionMenuOpen(false)} className="w-44 p-1">
                  {allowAttachments && (
                    <button
                      type="button"
                      onClick={() => {
                        setActionMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 min-h-11 text-left text-xs text-text-primary hover:bg-glass-bg"
                    >
                      <FileUp className="h-4 w-4 text-zinc-400" />
                      <span>{actionLabels?.file ?? "File"}</span>
                    </button>
                  )}
                  {onTransfer && (
                    <button
                      type="button"
                      onClick={() => {
                        setActionMenuOpen(false);
                        onTransfer();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 min-h-11 text-left text-xs text-text-primary hover:bg-glass-bg"
                    >
                      <Coins className="h-4 w-4 text-zinc-400" />
                      <span>{actionLabels?.transfer ?? "Transfer"}</span>
                    </button>
                  )}
                </ComposerPopover>
              )}
              <button
                type="button"
                onClick={() => setActionMenuOpen((open) => !open)}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-glass-bg hover:text-neon-cyan"
                title={actionLabels?.add ?? "Add"}
                aria-label={actionLabels?.add ?? "Open actions"}
                aria-expanded={actionMenuOpen}
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
        <div className="relative min-w-0 flex-1 max-md:order-first max-md:basis-full">
          {pickedMentions.length > 0 && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="whitespace-pre-wrap break-words border border-transparent px-3 py-2 text-base md:text-sm [@media(pointer:coarse)]:text-base text-text-primary" style={{ transform: `translateY(-${inputScrollTop}px)`, overflowWrap: "break-word" }}>
                {pickedMentions.map((mention, index) => (
                  <span key={`${mention.start}:${mention.agent_id}`}>
                    {text.slice(index === 0 ? 0 : pickedMentions[index - 1].end, mention.start)}
                    <span className="rounded bg-neon-cyan/10 text-neon-cyan">{text.slice(mention.start, mention.end)}</span>
                  </span>
                ))}
                {text.slice(pickedMentions[pickedMentions.length - 1].end)}{"\n"}
              </div>
            </div>
          )}
        <textarea
          ref={inputRef}
          id={inputId}
          name={MESSAGE_COMPOSER_TEXTAREA_NAME}
          autoComplete={MESSAGE_COMPOSER_TEXTAREA_AUTOCOMPLETE}
          autoCapitalize="sentences"
          autoCorrect="on"
          inputMode="text"
          spellCheck={true}
          data-form-type="other"
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-protonpass-ignore="true"
          aria-autocomplete={mentionEnabled ? "list" : MESSAGE_COMPOSER_TEXTAREA_ARIA_AUTOCOMPLETE}
          aria-haspopup={mentionEnabled ? "listbox" : undefined}
          aria-controls={mentionMatch && suggestions.length > 0 ? mentionListId : undefined}
          aria-activedescendant={mentionMatch && suggestions.length > 0 ? `${mentionListId}-${mentionIndex}` : undefined}
          aria-invalid={hasLengthError || undefined}
          style={pickedMentions.length > 0 ? { color: "transparent", caretColor: "var(--color-text-primary)", background: "transparent" } : undefined}
          onScroll={(event) => setInputScrollTop(event.currentTarget.scrollTop)}
          className={`liquid-input relative block w-full min-w-0 min-h-11 resize-none rounded-xl border px-3 py-2 text-base md:text-sm [@media(pointer:coarse)]:text-base text-text-primary placeholder-text-secondary/65 focus:outline-none ${
            hasLengthError
              ? "border-red-500/70 focus:border-red-500/80"
              : emptyState
              ? "border-cyan-500/40 shadow-[0_0_8px_rgba(0,240,255,0.1)] animate-[pulse-border_2s_ease-in-out_infinite]"
              : "border-zinc-700"
          }`}
          aria-label={placeholder}
          enterKeyHint="enter"
          placeholder={placeholder}
          value={text}
          maxLength={MESSAGE_MAX_LENGTH}
          onChange={(e) => {
            const nextText = e.target.value;
            const edit = nativeEditRef.current;
            setPickedMentions(reconcileDraftMentions(text, nextText, pickedMentions, edit?.before === text ? edit : undefined));
            nativeEditRef.current = null;
            setText(nextText);
            if (nextText.length < MESSAGE_MAX_LENGTH) setShowLengthError(false);
            if (nextText.length > MESSAGE_MAX_LENGTH) setShowLengthError(true);
            autoResize();
            updateMentionMatch();
          }}
          onBeforeInput={handleBeforeInput}
          onPaste={handlePaste}
          onCompositionStart={() => {
            compositionActiveRef.current = true;
          }}
          onCompositionEnd={() => {
            setTimeout(() => {
              compositionActiveRef.current = false;
            }, 0);
          }}
          onSelect={updateMentionMatch}
          onFocus={() => { if (blurTimerRef.current) clearTimeout(blurTimerRef.current); }}
          onBlur={() => {
            compositionActiveRef.current = false;
            blurTimerRef.current = setTimeout(() => setMentionMatch(null), 200);
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
        />
        </div>
        {mentionMatch && suggestions.length > 0 && (
          <ComposerPopover anchorRef={composerRowRef} onClose={() => setMentionMatch(null)} matchWidth>
          <div
            ref={mentionListRef}
            className="origin-bottom"
            id={mentionListId}
            aria-label={actionLabels?.mention ?? "Mention someone"}
            role="listbox"
          >
            {suggestions.map((s, i) => {
              const kind = s.agent_id === "@all"
                ? "all"
                : s.agent_id.startsWith("ag_")
                  ? "bot"
                  : s.agent_id.startsWith("hu_")
                    ? "user"
                    : s.agent_id.startsWith("rm_")
                      ? "room"
                      : "other";
              const KindIcon = kind === "bot" ? Bot : kind === "user" ? User : kind === "room" ? Hash : AtSign;
              const iconClass = kind === "bot"
                ? "text-cyan-400"
                : kind === "user"
                  ? "text-emerald-400"
                  : kind === "room"
                    ? "text-amber-400"
                    : "text-zinc-400";
              const kindLabel = kind === "bot" ? "Bot" : kind === "user" ? "User" : kind === "room" ? "Room" : kind === "all" ? "All" : "";
              return (
                <button
                  ref={(node) => { mentionOptionRefs.current[i] = node; }}
                  type="button"
                  key={s.agent_id}
                  id={`${mentionListId}-${i}`}
                  tabIndex={-1}
                  role="option"
                  aria-selected={i === mentionIndex}
                  onPointerDown={(event) => {
                    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
                    event.preventDefault();
                  }}
                  onClick={() => commitMention(s)}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 min-h-11 text-left text-xs transition-colors ${
                    i === mentionIndex
                      ? "bg-neon-cyan/15 text-neon-cyan"
                      : "text-text-primary hover:bg-glass-bg"
                  }`}
                >
                  <KindIcon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                  <span className="truncate font-medium">{s.display_name}</span>
                  {kindLabel && (
                    <span className={`shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide ${iconClass} bg-glass-bg`}>
                      {kindLabel}
                    </span>
                  )}
                  <span className="ml-auto max-w-[35%] truncate font-mono text-[10px] text-zinc-500">{s.id ?? s.agent_id}</span>
                </button>
              );
            })}
          </div>
          </ComposerPopover>
        )}
        <button
          ref={sendButtonRef}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleSendClick}
          disabled={!canSend}
          className="liquid-send-button max-md:ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-neon-cyan/15 text-neon-cyan transition-colors hover:bg-neon-cyan/25 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Send message"
        >
          <Send ref={sendIconRef} className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
