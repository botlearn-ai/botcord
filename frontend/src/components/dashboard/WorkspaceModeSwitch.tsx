"use client";

import LinkButton from "@/components/ui/LinkButton";
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
    <header className="dashboard-workspace-switch flex h-14 shrink-0 max-md:h-11 items-center justify-center border-b border-glass-border bg-glass-bg px-4">
      <nav aria-label={zh ? "工作模式" : "Workspace mode"} className="inline-flex items-center gap-1 rounded-xl border border-glass-border bg-deep-black p-1">
        {[
          { team: false, href: personalHref, label: zh ? "个人" : "Personal", Icon: UserRound },
          { team: true, href: teamHref, label: "Team", Icon: Users },
        ].map(({ team, href, label, Icon }) => (
          <LinkButton variant="ghost" size="sm"
            key={label}
            href={href}
            aria-current={teamMode === team ? "page" : undefined}
            aria-pressed={teamMode === team}
            className="min-w-24"
          >
            <Icon size={15} />{label}
          </LinkButton>
        ))}
      </nav>
    </header>
  );
}
