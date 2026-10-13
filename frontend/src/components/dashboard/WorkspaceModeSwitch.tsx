/**
 * [INPUT]: Current workspace mode, remembered destinations and interface language
 * [OUTPUT]: Responsive, equal-width workspace navigation with native links
 * [POS]: Shared dashboard header, including the loading shell
 * [PROTOCOL]: Keep touch targets inside the header; use BotCord UI tokens and LinkButton
 */
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
    <header className="dashboard-workspace-switch flex min-h-16 shrink-0 items-center justify-center border-b border-border bg-surface px-4 py-2">
      <nav aria-label={zh ? "工作模式" : "Workspace mode"} className="grid w-full max-w-xs grid-cols-2 items-center gap-1 rounded-xl bg-surface-sunken p-1 md:max-w-64">
        {[
          { team: false, href: personalHref, label: zh ? "个人" : "Personal", Icon: UserRound },
          { team: true, href: teamHref, label: zh ? "团队" : "Team", Icon: Users },
        ].map(({ team, href, label, Icon }) => (
          <LinkButton variant="ghost" size="md"
            key={label}
            href={href}
            aria-current={teamMode === team ? "page" : undefined}
            className="min-w-0"
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
            {label}
          </LinkButton>
        ))}
      </nav>
    </header>
  );
}
