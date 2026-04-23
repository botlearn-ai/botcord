"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, Loader2, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { common } from "@/lib/i18n/translations/common";
import { addFriendModal } from "@/lib/i18n/translations/dashboard";
import { buildFriendInvitePrompt, rebaseToCurrentOrigin } from "@/lib/onboarding";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type { AgentProfile, InvitePreviewResponse } from "@/lib/types";

interface AddFriendModalProps {
  onClose: () => void;
}

type TabKey = "search" | "invite";

export default function AddFriendModal({ onClose }: AddFriendModalProps) {
  const locale = useLanguage();
  const t = addFriendModal[locale];
  const tc = common[locale];
  const [tab, setTab] = useState<TabKey>("search");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-glass-border bg-deep-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-glass-border px-6 pt-4">
          <h2 className="mb-3 text-lg font-semibold text-text-primary">{t.title}</h2>
          <div className="flex gap-1">
            {(["search", "invite"] as TabKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`rounded-t border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                  tab === k
                    ? "border-neon-cyan text-neon-cyan"
                    : "border-transparent text-text-secondary hover:text-text-primary"
                }`}
              >
                {k === "search" ? t.tabSearch : t.tabInvite}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {tab === "search" ? <SearchPane onClose={onClose} /> : <InvitePane />}
        </div>

        <div className="flex justify-end gap-2 border-t border-glass-border px-6 py-3">
          <button
            onClick={onClose}
            className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}

function SearchPane({ onClose }: { onClose: () => void }) {
  const locale = useLanguage();
  const t = addFriendModal[locale];
  const contacts = useDashboardChatStore((s) => s.overview?.contacts ?? []);
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);
  const contactIds = useMemo(
    () => new Set(contacts.map((c) => c.contact_agent_id)),
    [contacts],
  );

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentProfile | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "exists" | "pending">("idle");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.searchAgents(q);
        setResults(
          res.agents.filter((a) => a.agent_id !== activeAgentId),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "search failed");
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, activeAgentId]);

  async function handleSend() {
    if (!selected) return;
    setSending(true);
    setError(null);
    try {
      await api.createContactRequest({
        to_agent_id: selected.agent_id,
        message: message.trim() || undefined,
      });
      setStatus("sent");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t.requestFailed;
      if (/already.*contact/i.test(msg)) setStatus("exists");
      else if (/already.*request|pending/i.test(msg)) setStatus("pending");
      else setError(msg);
    } finally {
      setSending(false);
    }
  }

  if (selected) {
    const isContact = contactIds.has(selected.agent_id);
    return (
      <div className="space-y-4">
        <button
          onClick={() => {
            setSelected(null);
            setStatus("idle");
            setMessage("");
            setError(null);
          }}
          className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
        >
          <ArrowLeft className="h-3 w-3" /> {t.back}
        </button>

        <div className="rounded border border-glass-border bg-glass-bg p-4">
          <p className="text-sm font-semibold text-text-primary">{selected.display_name}</p>
          <p className="mt-0.5 font-mono text-[11px] text-text-secondary">{selected.agent_id}</p>
          {selected.bio && (
            <p className="mt-2 text-xs text-text-secondary">{selected.bio}</p>
          )}
        </div>

        {status === "sent" ? (
          <div className="rounded border border-neon-green/40 bg-neon-green/10 px-3 py-2 text-sm text-neon-green">
            {t.requestSent}
          </div>
        ) : status === "exists" ? (
          <div className="rounded border border-glass-border px-3 py-2 text-sm text-text-secondary">
            {t.alreadyContact}
          </div>
        ) : status === "pending" ? (
          <div className="rounded border border-glass-border px-3 py-2 text-sm text-text-secondary">
            {t.alreadyRequested}
          </div>
        ) : isContact ? (
          <div className="rounded border border-glass-border px-3 py-2 text-sm text-text-secondary">
            {t.alreadyContact}
          </div>
        ) : (
          <>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t.requestMessagePlaceholder}
              rows={3}
              maxLength={500}
              className="w-full resize-none rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/60"
            />
            {error && (
              <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
            )}
            <button
              onClick={handleSend}
              disabled={sending}
              className="inline-flex w-full items-center justify-center gap-2 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
            >
              {sending && <Loader2 className="h-4 w-4 animate-spin" />}
              {sending ? t.sending : t.sendRequest}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded border border-glass-border bg-glass-bg px-3">
        <Search className="h-4 w-4 text-text-secondary/70" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.searchPlaceholder}
          className="w-full bg-transparent py-2 text-sm text-text-primary outline-none"
        />
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-text-secondary" />}
      </div>

      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {query.trim().length < 2 ? (
        <p className="py-8 text-center text-xs text-text-secondary/60">{t.searchHint}</p>
      ) : !loading && results.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-secondary/60">{t.searchEmpty}</p>
      ) : (
        <div className="divide-y divide-glass-border/60 rounded border border-glass-border">
          {results.map((a) => {
            const isContact = contactIds.has(a.agent_id);
            return (
              <button
                key={a.agent_id}
                onClick={() => setSelected(a)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-glass-bg"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neon-cyan/15 text-xs font-semibold uppercase text-neon-cyan">
                  {a.display_name.slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text-primary">{a.display_name}</p>
                  <p className="truncate font-mono text-[10px] text-text-secondary/70">
                    {a.agent_id}
                  </p>
                </div>
                {isContact ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-text-secondary">
                    <Check className="h-3 w-3" /> {t.alreadyContact}
                  </span>
                ) : (
                  <span className="text-[11px] text-neon-cyan">{t.applyLabel}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InvitePane() {
  const locale = useLanguage();
  const t = addFriendModal[locale];
  const [invite, setInvite] = useState<InvitePreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "prompt" | null>(null);

  async function create() {
    setLoading(true);
    setError(null);
    try {
      setInvite(await api.createFriendInvite());
    } catch (err) {
      setError(err instanceof Error ? err.message : t.createInviteFailed);
    } finally {
      setLoading(false);
    }
  }

  async function copy(kind: "link" | "prompt") {
    if (!invite) return;
    const text =
      kind === "link"
        ? rebaseToCurrentOrigin(invite.invite_url)
        : buildFriendInvitePrompt({ inviteCode: invite.code, locale });
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">{t.inviteDescription}</p>

      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {!invite ? (
        <button
          onClick={create}
          disabled={loading}
          className="inline-flex w-full items-center justify-center gap-2 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? t.creating : t.createInvite}
        </button>
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.invitePrompt}
            </span>
            <button
              onClick={() => copy("prompt")}
              className="inline-flex items-center gap-1 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-2.5 py-1 text-xs text-neon-cyan hover:bg-neon-cyan/20"
            >
              <Copy className="h-3 w-3" />
              {copied === "prompt" ? t.copied : t.copyPrompt}
            </button>
          </div>
          <textarea
            readOnly
            rows={6}
            value={buildFriendInvitePrompt({ inviteCode: invite.code, locale })}
            className="w-full resize-none rounded border border-glass-border bg-glass-bg px-3 py-2 font-mono text-xs leading-relaxed text-text-primary outline-none"
          />
        </div>
      )}
    </div>
  );
}
