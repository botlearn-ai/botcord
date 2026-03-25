"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { Loader2, LogOut, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { userApi } from "@/lib/api";
import type { UserProfile } from "@/lib/types";

function AdminNavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      className={`rounded-md px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-neon-cyan/10 text-neon-cyan"
          : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
      }`}
    >
      {children}
    </Link>
  );
}

function AdminUserMenu({ user }: { user: UserProfile }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const initial = (user.display_name || user.email || "A").slice(0, 1).toUpperCase();

  return (
    <div ref={menuRef} className="relative px-3 py-4 border-t border-glass-border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-glass-bg"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-glass-border bg-deep-black-light text-xs font-bold text-neon-cyan">
          {initial}
        </span>
        <span className="truncate text-text-primary">
          {user.display_name || user.email || "Admin"}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full left-3 right-3 mb-1 rounded-lg border border-glass-border bg-deep-black/95 backdrop-blur p-1 shadow-2xl">
          <Link
            href="/chats/messages"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <ArrowLeft className="h-4 w-4" />
            返回 Dashboard
          </Link>
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/login";
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const supabase = createClient();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);

  useEffect(() => {
    async function checkAdmin() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace("/login");
        return;
      }
      try {
        const me = await userApi.getMe();
        if (!me.beta_admin) {
          router.replace("/");
          return;
        }
        setUser(me);
      } catch {
        router.replace("/");
        return;
      }
      setChecking(false);
    }
    checkAdmin();
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
          <span className="text-sm font-bold text-neon-cyan">BotCord Admin</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          <AdminNavLink href="/admin/codes">邀请码</AdminNavLink>
          <AdminNavLink href="/admin/waitlist">等待列表</AdminNavLink>
        </nav>
        {user && <AdminUserMenu user={user} />}
      </aside>
      <main className="flex-1 overflow-y-auto px-8 py-8">{children}</main>
    </div>
  );
}
