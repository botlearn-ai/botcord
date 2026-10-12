"use client";

import LinkButton from "@/components/ui/LinkButton";
import Avatar from "@/components/ui/Avatar";
import Menu, { MenuTrigger, MenuContent, MenuItem } from "@/components/ui/Menu";
import { BotCordLoader } from "@/components/ui/BotCordLoader";
import Button from "@/components/ui/Button";
import { useEffect, useState } from "react";
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
    <LinkButton href={href} variant="row" aria-current={active ? "page" : undefined}>{children}</LinkButton>
  );
}

function AdminUserMenu({ user }: { user: UserProfile }) {
  const supabase = createClient();
  const name = user.display_name || user.email || "Admin";
  return (
    <div className="border-t border-border px-3 py-4">
      <Menu>
        <MenuTrigger asChild><Button variant="row" className="flex w-full items-center gap-3"><Avatar kind="human" id={user.id} name={name} size="sm" /><span className="truncate">{name}</span></Button></MenuTrigger>
        <MenuContent side="top">
          <MenuItem asChild><Link href="/chats/messages"><ArrowLeft className="h-4 w-4" />返回 Dashboard</Link></MenuItem>
          <MenuItem danger icon={<LogOut className="h-4 w-4" />} onSelect={async () => { await supabase.auth.signOut(); window.location.href = "/login"; }}>退出登录</MenuItem>
        </MenuContent>
      </Menu>
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
        <BotCordLoader />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text-primary md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-border md:w-56 md:border-b-0 md:border-r">
        <div className="px-5 py-5">
          <span className="text-sm font-semibold text-neon-cyan">BotCord Admin</span>
        </div>
        <nav className="flex flex-1 gap-1 overflow-x-auto px-3 md:flex-col">
          <AdminNavLink href="/admin/codes">邀请码</AdminNavLink>
          <AdminNavLink href="/admin/waitlist">等待列表</AdminNavLink>
        </nav>
        {user && <AdminUserMenu user={user} />}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
