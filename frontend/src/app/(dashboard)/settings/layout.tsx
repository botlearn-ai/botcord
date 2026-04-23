"use client";

/**
 * [INPUT]: Supabase session for auth gating, current pathname for active-nav highlight
 * [OUTPUT]: SettingsLayout — sidebar + auth gate for /settings/* dashboard subroutes
 * [POS]: shared shell for dashboard settings pages (daemons, etc.)
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, Server } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function SettingsNavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-neon-cyan/10 text-neon-cyan"
          : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
      }`}
    >
      {icon}
      {children}
    </Link>
  );
}

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session) {
        router.replace("/login");
        return;
      }
      setChecking(false);
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-deep-black">
        <Loader2 className="h-6 w-6 animate-spin text-neon-cyan" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-deep-black text-text-primary">
      <aside className="flex w-56 shrink-0 flex-col border-r border-glass-border">
        <div className="px-5 py-5">
          <span className="text-sm font-bold text-neon-cyan">Settings</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          <SettingsNavLink
            href="/settings/daemons"
            icon={<Server className="h-4 w-4" />}
          >
            Daemons
          </SettingsNavLink>
        </nav>
        <div className="border-t border-glass-border px-3 py-3">
          <Link
            href="/chats/messages"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Link>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto px-8 py-8">{children}</main>
    </div>
  );
}
