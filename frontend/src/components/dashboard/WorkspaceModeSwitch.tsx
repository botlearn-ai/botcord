"use client";

import Link from "next/link";
import { UserRound, Users } from "lucide-react";
import { useLanguage } from "@/lib/i18n";

export default function WorkspaceModeSwitch({
  teamMode,
  personalHref,
  teamHref = "/chats/team",
}: {
  teamMode: boolean;
  personalHref: string;
  teamHref?: string;
}) {
  const zh = useLanguage() === "zh";
  return (
    <header className="flex h-14 shrink-0 items-center justify-center border-b border-glass-border bg-glass-bg px-4">
      <nav aria-label={zh ? "工作模式" : "Workspace mode"} className="inline-flex items-center gap-1 rounded-xl border border-glass-border bg-deep-black p-1">
        {[
          { team: false, href: personalHref, label: zh ? "个人" : "Personal", Icon: UserRound },
          { team: true, href: teamHref, label: "Team", Icon: Users },
        ].map(({ team, href, label, Icon }) => (
          <Link
            key={label}
            href={href}
            aria-current={teamMode === team ? "page" : undefined}
            className={`inline-flex min-w-24 items-center justify-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-neon-cyan ${teamMode === team ? "bg-neon-cyan/10 text-neon-cyan shadow-sm" : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"}`}
          >
            <Icon size={15} />{label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
