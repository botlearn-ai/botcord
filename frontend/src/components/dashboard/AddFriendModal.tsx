"use client";
import Tabs from "@/components/ui/Tabs";
import Alert from "@/components/ui/Alert";
import Card from "@/components/ui/Card";
import DialogSurface from "@/components/ui/DialogSurface";

import Button from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Input } from "@/components/ui/Input";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Loader2, Search } from "lucide-react";
import { api, humansApi } from "@/lib/api";
import { animateOverlayPanelEnter, animateOverlayPanelExit, animatePop, cleanupAnime } from "@/lib/anime";
import { useLanguage } from "@/lib/i18n";
import { common } from "@/lib/i18n/translations/common";
import { addFriendModal } from "@/lib/i18n/translations/dashboard";
import { buildFriendInvitePrompt, rebaseToCurrentOrigin } from "@/lib/onboarding";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type { ContactInfo, InvitePreviewResponse } from "@/lib/types";

const EMPTY_CONTACTS: ContactInfo[] = [];

interface AddFriendModalProps {
  onClose: () => void;
}

type TabKey = "search" | "invite";

type PeerKind = "agent" | "human";

type PeerResult = {
  id: string;
  kind: PeerKind;
  display_name: string;
  bio: string | null;
};

export default withDashboardOverlayPortal(AddFriendModal);

function AddFriendModal({ onClose }: AddFriendModalProps) {
  const locale = useLanguage();
  const t = addFriendModal[locale];
  const tc = common[locale];
  const [tab, setTab] = useState<TabKey>("search");
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

  const closeWithMotion = useCallback(() => {
    if (closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, onClose]);

  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; } });
    return () => cleanupAnime(animationRef.current);
  }, []);

  return (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} title={<>{t.title}</>} overlayClassName="z-50" className="max-w-lg overflow-hidden">
        <div className="liquid-toolbar border-b px-6 pt-4">
          <h2 className="mb-3 text-lg font-semibold text-text-primary">{t.title}</h2>
          <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)} variant="underline" ariaLabel={t.title}
            items={[{ value: "search", label: t.tabSearch }, { value: "invite", label: t.tabInvite }]} />
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {tab === "search" ? <SearchPane onClose={closeWithMotion} /> : <InvitePane />}
        </div>

        <div className="liquid-toolbar flex justify-end gap-2 border-t px-6 py-3">
          <Button variant="secondary"
            onClick={closeWithMotion}

          >
            {t.close}
          </Button>
        </div>
      </DialogSurface>
  );
}

function PeerKindBadge({ kind }: { kind: PeerKind }) {
  const locale = useLanguage();
  const t = addFriendModal[locale];
  const label = kind === "human" ? t.kindHuman : t.kindBot;
  const cls =
    kind === "human"
      ? "border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan"
      : "border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan";
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function SearchPane({ onClose }: { onClose: () => void }) {
  const locale = useLanguage();
  const t = addFriendModal[locale];
  const contacts = useDashboardChatStore((s) => s.overview?.contacts) ?? EMPTY_CONTACTS;
  const refreshOverview = useDashboardChatStore((s) => s.refreshOverview);
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);
  // Identity signal: viewMode flips to "human" once /api/humans/me loads.
  const viewMode = useDashboardSessionStore((s) => s.viewMode);
  const human = useDashboardSessionStore((s) => s.human);
  const identityReady =
    viewMode === "human" ? Boolean(human) : Boolean(activeAgentId);
  const contactIds = useMemo(
    () => new Set(contacts.map((c) => c.contact_agent_id)),
    [contacts],
  );
  const myHumanId = human?.human_id ?? null;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PeerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PeerResult | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "exists" | "pending">("idle");
  const statusRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const feedbackAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

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
        const agentPeers: PeerResult[] = res.agents.map((a) => ({
          id: a.agent_id,
          kind: "agent",
          display_name: a.display_name,
          bio: a.bio,
        }));
        const humanPeers: PeerResult[] = (res.humans ?? []).map((h) => ({
          id: h.human_id,
          kind: "human",
          display_name: h.display_name,
          bio: null,
        }));
        const selfIds = new Set<string>();
        if (activeAgentId) selfIds.add(activeAgentId);
        if (myHumanId) selfIds.add(myHumanId);
        setResults([...agentPeers, ...humanPeers].filter((p) => !selfIds.has(p.id)));
      } catch (err) {
        setError(err instanceof Error ? err.message : "search failed");
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, activeAgentId, myHumanId]);

  async function handleSend() {
    if (!selected) return;
    setSending(true);
    setError(null);
    try {
      const targetId = selected.id;
      const targetIsHuman = selected.kind === "human";
      const trimmedMsg = message.trim() || undefined;

      // Agent → Human goes to /api/dashboard/contact-requests with the
      // polymorphic `to_human_id` field; A→A keeps `to_agent_id`.
      // `createContactRequest` accepts the tagged-union body directly.
      const agentPayload = targetIsHuman
        ? { to_human_id: targetId, message: trimmedMsg }
        : { to_agent_id: targetId, message: trimmedMsg };

      const res =
        viewMode === "human"
          ? await humansApi.sendContactRequest({
              peer_id: targetId,
              message: trimmedMsg,
            })
          : await api.createContactRequest(agentPayload);

      // Human BFF returns a structured ContactRequestOutcome; agent BFF just
      // returns 201 on success or throws. Translate to existing UI states.
      if (
        res &&
        typeof res === "object" &&
        "status" in res &&
        typeof (res as { status: unknown }).status === "string"
      ) {
        const s = (res as { status: string }).status;
        if (s === "already_contact") setStatus("exists");
        else if (s === "already_requested") setStatus("pending");
        else setStatus("sent");
      } else {
        setStatus("sent");
      }
      await refreshOverview();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t.requestFailed;
      if (/already.*contact/i.test(msg)) {
        setStatus("exists");
        await refreshOverview();
      } else if (/already.*request|pending/i.test(msg)) {
        setStatus("pending");
      } else {
        setError(msg);
      }
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    const target = status === "idle" ? null : statusRef.current;
    if (!target) return;
    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animatePop(target);
    return () => cleanupAnime(feedbackAnimationRef.current);
  }, [status]);

  useEffect(() => {
    if (!error || !errorRef.current) return;
    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animatePop(errorRef.current);
    return () => cleanupAnime(feedbackAnimationRef.current);
  }, [error]);

  if (selected) {
    const isContact = contactIds.has(selected.id);
    return (
      <div className="space-y-4">
        <Button variant="secondary"
          onClick={() => {
            setSelected(null);
            setStatus("idle");
            setMessage("");
            setError(null);
          }}

        >
          <ArrowLeft className="h-3 w-3" /> {t.back}
        </Button>

        <Card padding="none" className="p-4">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-text-primary">{selected.display_name}</p>
            <PeerKindBadge kind={selected.kind} />
          </div>
          {selected.bio && (
            <p className="mt-2 text-xs text-text-secondary">{selected.bio}</p>
          )}
        </Card>

        {status === "sent" ? (
          <div ref={statusRef} className="rounded border border-neon-green/40 bg-neon-green/10 px-3 py-2 text-sm text-neon-green">
            {t.requestSent}
          </div>
        ) : status === "exists" ? (
          <Card padding="none" ref={statusRef} className="px-3 py-2">
            {t.alreadyContact}
          </Card>
        ) : status === "pending" ? (
          <Card padding="none" ref={statusRef} className="px-3 py-2">
            {t.alreadyRequested}
          </Card>
        ) : isContact ? (
          <Card padding="none" className="px-3 py-2">
            {t.alreadyContact}
          </Card>
        ) : (
          <>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t.requestMessagePlaceholder}
              rows={3}
              maxLength={500}
              className="w-full"
            />
            {error && (
              <Alert tone="danger" ref={errorRef} >
                {error}
              </Alert>
            )}
            <Button variant="primary"
              onClick={handleSend}
              disabled={sending || !identityReady}
              title={!identityReady ? t.requestFailed : undefined}
              className="w-full"
            >
              {sending && <Loader2 className="h-4 w-4 animate-spin" />}
              {sending ? t.sending : t.sendRequest}
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="liquid-input flex items-center gap-2 rounded-lg border px-3">
        <Search className="h-4 w-4 text-text-secondary" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.searchPlaceholder}
          className="w-full"
        />
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-text-secondary" />}
      </div>

      {error && (
        <Alert tone="danger" ref={errorRef} >
          {error}
        </Alert>
      )}

      {query.trim().length < 2 ? (
        <p className="py-8 text-center text-xs text-text-secondary">{t.searchHint}</p>
      ) : !loading && results.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-secondary">{t.searchEmpty}</p>
      ) : (
        <Card padding="none" className="overflow-hidden">
          {results.map((a) => {
            const isContact = contactIds.has(a.id);
            return (
              <Button variant="row"
                key={a.id}
                onClick={() => setSelected(a)}
                className="w-full"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neon-cyan/15 text-xs font-semibold uppercase text-neon-cyan">
                  {a.display_name.slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm text-text-primary">{a.display_name}</p>
                    <PeerKindBadge kind={a.kind} />
                  </div>
                </div>
                {isContact ? (
                  <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                    <Check className="h-3 w-3" /> {t.alreadyContact}
                  </span>
                ) : (
                  <span className="text-xs text-neon-cyan">{t.applyLabel}</span>
                )}
              </Button>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function InvitePane() {
  const locale = useLanguage();
  const t = addFriendModal[locale];
  const isHumanView = useDashboardSessionStore((state) => state.viewMode === "human");
  const [invite, setInvite] = useState<InvitePreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "prompt" | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const feedbackAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  async function create() {
    setLoading(true);
    setError(null);
    try {
      const inviteApi = isHumanView ? humansApi : api;
      setInvite(await inviteApi.createFriendInvite());
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

  useEffect(() => {
    if (!error || !errorRef.current) return;
    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animatePop(errorRef.current);
    return () => cleanupAnime(feedbackAnimationRef.current);
  }, [error]);

  useEffect(() => {
    if (!copied || !copyRef.current) return;
    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animatePop(copyRef.current);
    return () => cleanupAnime(feedbackAnimationRef.current);
  }, [copied]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">{t.inviteDescription}</p>

      {error && (
        <Alert tone="danger" ref={errorRef} >
          {error}
        </Alert>
      )}

      {!invite ? (
        <Button variant="primary"
          onClick={create}
          disabled={loading}
          className="w-full"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? t.creating : t.createInvite}
        </Button>
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-text-secondary">
              {t.invitePrompt}
            </span>
            <Button variant="primary"
              ref={copyRef}
              onClick={() => copy("prompt")}

            >
              <Copy className="h-3 w-3" />
              {copied === "prompt" ? t.copied : t.copyPrompt}
            </Button>
          </div>
          <Textarea
            readOnly
            rows={6}
            value={buildFriendInvitePrompt({ inviteCode: invite.code, locale })}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}
