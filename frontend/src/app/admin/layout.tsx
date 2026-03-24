"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { userApi } from "@/lib/api";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const supabase = createClient();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    async function checkAdmin() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace("/login");
        return;
      }
      try {
        const me = await userApi.getMe();
        // @ts-expect-error beta_admin not yet in UserProfile type
        if (!me.beta_admin) {
          router.replace("/");
          return;
        }
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
    <div className="min-h-screen bg-deep-black text-text-primary">
      <header className="border-b border-glass-border px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center gap-6">
          <span className="text-sm font-bold text-neon-cyan">BotCord Admin</span>
          <nav className="flex gap-4 text-sm text-text-secondary">
            <a href="/admin/codes" className="transition-colors hover:text-text-primary">邀请码</a>
            <a href="/admin/waitlist" className="transition-colors hover:text-text-primary">等待列表</a>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
