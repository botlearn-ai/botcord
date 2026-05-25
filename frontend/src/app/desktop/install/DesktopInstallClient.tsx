"use client";

/**
 * [INPUT]: authenticated dashboard session, query params from BotCord Desktop
 * [OUTPUT]: DesktopInstallClient — mints a one-time daemon install ticket.
 *   - In a plain browser, redirects to `botcord://install?install_token=...` for the
 *     desktop deep-link handler to redeem.
 *   - When loaded inside the BotCord Desktop iframe, calls the local bridge to
 *     redeem the token in-process — no deep-link bounce.
 * [POS]: browser leg of the Desktop DMG auth flow
 * [PROTOCOL]: update when desktop deep-link params change
 */

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { desktopBridge, getDesktopInfo } from "@/lib/desktop-bridge";
import { apiFetch } from "@/lib/api";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://api.botcord.chat");

function sanitizeCallback(raw: string | null): string {
  if (!raw) return "botcord://install";
  try {
    const url = new URL(raw);
    if (url.protocol === "botcord:" && url.hostname === "install") {
      return url.toString();
    }
  } catch {
    // fall through
  }
  return "botcord://install";
}

function sameOriginNextPath(): string {
  const path = `${window.location.pathname}${window.location.search}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/desktop/install";
}

function sanitizeNextPath(raw: string | null): string {
  if (!raw) return "/chats/home";
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/chats/home";
}

type Phase =
  | { kind: "probing" }
  | { kind: "minting" }
  | { kind: "redirect"; url: string }
  | { kind: "desktop-connecting" }
  | { kind: "desktop-connected"; detail: string }
  | { kind: "error"; message: string };

export default function DesktopInstallClient() {
  const searchParams = useSearchParams();
  const [phase, setPhase] = useState<Phase>({ kind: "probing" });

  const callback = useMemo(
    () => sanitizeCallback(searchParams.get("callback")),
    [searchParams],
  );
  const hub = searchParams.get("hub") || HUB_BASE_URL;
  const label = searchParams.get("label") || "";
  const nextPath = useMemo(
    () => sanitizeNextPath(searchParams.get("next")),
    [searchParams],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const info = await getDesktopInfo();
        const isDesktop = info !== null;

        setPhase({ kind: "minting" });
        const res = await apiFetch("/daemon/auth/install-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(label ? { label } : {}),
        });
        if (res.status === 401) {
          window.location.replace(`/login?next=${encodeURIComponent(sameOriginNextPath())}`);
          return;
        }
        if (!res.ok) {
          throw new Error(await res.text());
        }
        const data = (await res.json()) as { install_token?: string };
        if (!data.install_token) {
          throw new Error("install_token missing");
        }
        if (cancelled) return;

        if (isDesktop) {
          setPhase({ kind: "desktop-connecting" });
          const detail = await desktopBridge.connectWithInstallToken({
            hubUrl: hub,
            installToken: data.install_token,
            label,
          });
          if (cancelled) return;
          setPhase({ kind: "desktop-connected", detail });
          window.location.replace(nextPath);
          return;
        }

        const out = new URL(callback);
        out.searchParams.set("install_token", data.install_token);
        out.searchParams.set("hub", hub);
        if (label) out.searchParams.set("label", label);
        out.searchParams.set("next", nextPath);
        const url = out.toString();
        setPhase({ kind: "redirect", url });
        window.location.href = url;
      } catch (err) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            message: err instanceof Error ? err.message : "Failed to authorize desktop app",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [callback, hub, label, nextPath]);

  const isDone = phase.kind === "desktop-connected";
  const heading =
    phase.kind === "desktop-connecting" || phase.kind === "desktop-connected"
      ? "Connecting BotCord Desktop"
      : "Authorizing BotCord Desktop";
  const subtitle =
    phase.kind === "desktop-connected"
      ? "This device is now linked to your BotCord account."
      : phase.kind === "desktop-connecting"
        ? "Redeeming a one-time install token on this Mac…"
        : "Authorizing this Mac with a one-time install token.";

  return (
    <main className="flex min-h-screen items-center justify-center bg-deep-black px-4 text-text-primary">
      <section className="w-full max-w-md rounded-2xl border border-glass-border bg-glass-bg p-8 text-center backdrop-blur-xl">
        <div
          className={`mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl ${
            isDone ? "bg-neon-green/15 text-neon-green" : "bg-neon-cyan/15 text-neon-cyan"
          }`}
        >
          {isDone ? (
            <CheckCircle2 className="h-6 w-6" />
          ) : (
            <Loader2 className="h-6 w-6 animate-spin" />
          )}
        </div>
        <h1 className="mb-2 text-xl font-semibold">{heading}</h1>
        <p className="text-sm text-text-secondary">{subtitle}</p>

        {phase.kind === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-left text-sm text-red-300">
            {phase.message}
          </div>
        )}

        {phase.kind === "redirect" && (
          <Link
            href={phase.url}
            className="mt-5 inline-flex rounded-lg border border-glass-border px-3 py-2 text-sm text-text-secondary hover:bg-glass-bg hover:text-text-primary"
          >
            Return to BotCord
          </Link>
        )}

        {phase.kind === "desktop-connected" && (
          <p className="mt-5 text-xs text-text-secondary">{phase.detail}</p>
        )}
      </section>
    </main>
  );
}
