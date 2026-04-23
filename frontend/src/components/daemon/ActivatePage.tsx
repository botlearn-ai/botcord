"use client";

/**
 * [INPUT]: Supabase session for auth gating; fetch to /api/daemon/auth/* BFF routes
 * [OUTPUT]: ActivatePage — public-shell page that authorizes a new daemon
 *   via the device-code flow (plan §6.1)
 * [POS]: dashboard control-plane onboarding page rendered at /activate
 * [PROTOCOL]: update header on changes
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function formatUserCode(raw: string): string {
  // Keep alphanumerics only, uppercase, then group as XXXX-XXXX (max 8 chars).
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (cleaned.length <= 4) return cleaned;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

export default function ActivatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  // Code lifted from `?code=XXXX-XXXX` — preserved verbatim so we can both
  // render the "pre-filled" callout and forward it through /login?next=… when
  // the user is unauthenticated. `formatUserCode` normalizes to the canonical
  // XXXX-XXXX shape before we drop it into the form.
  const urlCode = searchParams?.get("code") ?? null;

  const [userCode, setUserCode] = useState("");
  const [label, setLabel] = useState("");
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approveOk, setApproveOk] = useState(false);
  const [prefilledFromUrl, setPrefilledFromUrl] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session) {
        // Preserve the original `?code=…` across the login round-trip so the
        // user lands back on this page with the prefill intact (plan §6.1).
        const nextPath = urlCode
          ? `/activate?code=${encodeURIComponent(urlCode)}`
          : "/activate";
        const next = encodeURIComponent(nextPath);
        router.replace(`/login?next=${next}`);
        return;
      }
      setAuthed(true);
      setAuthChecked(true);
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [router, supabase, urlCode]);

  // Plan §6.1: URL-borne `code` prefill is *convenience only* — still gated
  // behind Supabase auth + explicit Authorize click. We only hydrate the
  // field after auth is confirmed so the code never paints before the
  // redirect to /login would have kicked in.
  useEffect(() => {
    if (!authChecked || !authed) return;
    if (!urlCode) return;
    if (userCode) return;
    const formatted = formatUserCode(urlCode);
    if (!formatted) return;
    setUserCode(formatted);
    setPrefilledFromUrl(true);
  }, [authChecked, authed, urlCode, userCode]);

  const onUserCodeChange = useCallback((v: string) => {
    setUserCode(formatUserCode(v));
    // Any manual edit invalidates the "pre-filled from URL" hint — at that
    // point the code is whatever the user typed.
    if (prefilledFromUrl) setPrefilledFromUrl(false);
    if (approveOk) setApproveOk(false);
    if (approveError) setApproveError(null);
  }, [approveError, approveOk, prefilledFromUrl]);

  async function handleApprove(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = userCode.replace(/-/g, "");
    if (cleaned.length < 4) {
      setApproveError("Enter the code shown by the daemon.");
      return;
    }
    setApproving(true);
    setApproveError(null);
    setApproveOk(false);
    try {
      const res = await fetch("/api/daemon/auth/device-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_code: userCode,
          label: label.trim() || undefined,
        }),
      });
      if (!res.ok) {
        let msg = `Authorization failed (HTTP ${res.status})`;
        try {
          const data = await res.json();
          if (typeof data?.error === "string") msg = data.error;
          else if (typeof data?.detail === "string") msg = data.detail;
          else if (typeof data?.message === "string") msg = data.message;
        } catch {
          // ignore
        }
        setApproveError(msg);
        return;
      }
      setApproveOk(true);
      setUserCode("");
      setLabel("");
    } catch (err) {
      setApproveError(
        err instanceof Error ? err.message : "Network error",
      );
    } finally {
      setApproving(false);
    }
  }

  if (!authChecked || !authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-deep-black">
        <Loader2 className="h-6 w-6 animate-spin text-neon-cyan" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep-black text-text-primary">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header className="mb-10">
          <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">
            Activate a daemon
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            Authorize the BotCord daemon running on your machine to act on your
            behalf.
          </p>
        </header>

        <section className="rounded-2xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-neon-cyan" />
            <h2 className="text-base font-semibold text-text-primary">
              Authorize a new device
            </h2>
          </div>
          <p className="mb-5 text-sm text-text-secondary">
            Run <code className="rounded bg-deep-black-light px-1.5 py-0.5 font-mono text-xs text-neon-cyan">botcord-daemon start</code>{" "}
            on your machine. It will print a code like <code className="font-mono text-xs">ABCD-EFGH</code>. Paste it below.
          </p>

          <form onSubmit={handleApprove} className="space-y-4">
            <div>
              <label htmlFor="user-code" className="mb-1 block text-xs text-text-secondary">
                Device code
              </label>
              <input
                id="user-code"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="ABCD-EFGH"
                value={userCode}
                onChange={(e) => onUserCodeChange(e.target.value)}
                className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 font-mono text-base tracking-widest text-text-primary placeholder-text-tertiary outline-none focus:border-neon-cyan/50"
                maxLength={9}
              />
            </div>

            <div>
              <label htmlFor="device-label" className="mb-1 block text-xs text-text-secondary">
                Device name <span className="text-text-tertiary">(optional)</span>
              </label>
              <input
                id="device-label"
                type="text"
                placeholder="e.g. MacBook Pro"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary outline-none focus:border-neon-cyan/50"
                maxLength={64}
              />
            </div>

            {prefilledFromUrl && !approveOk && (
              <p className="rounded-xl border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-2 text-xs text-neon-cyan">
                Code pre-filled from URL — review and click Authorize.
              </p>
            )}

            {approveError && (
              <p className="rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-2 text-sm text-red-300">
                {approveError}
              </p>
            )}
            {approveOk && (
              <p className="rounded-xl border border-neon-green/30 bg-neon-green/10 px-4 py-2 text-sm text-neon-green">
                Done — your daemon should be online in a few seconds.
              </p>
            )}

            <button
              type="submit"
              disabled={approving || userCode.replace(/-/g, "").length < 4}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-neon-cyan/10 px-4 py-2.5 text-sm font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {approving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Authorize this device
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
