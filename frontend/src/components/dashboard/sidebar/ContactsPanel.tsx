"use client";

import { startTransition, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { ChevronDown, UserPlus2, Users } from "lucide-react";
import { CompositeAvatar } from "../CompositeAvatar";
import BotAvatar from "../BotAvatar";
import { SidebarListSkeleton, SkeletonBlock } from "../DashboardTabSkeleton";
import { useShallow } from "zustand/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useLanguage } from "@/lib/i18n";
import { contactsUi as contactsUiI18n } from "@/lib/i18n/translations/dashboard";

function Section({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-glass-border/50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70 transition-colors hover:text-text-primary"
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown
            className={`h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`}
          />
          {title}
        </span>
        <span className="text-[10px] font-medium text-text-secondary/50">{count}</span>
      </button>
      {open ? <div className="pb-2">{children}</div> : null}
    </div>
  );
}

function SubGroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-text-secondary/45">
      <span>{title}</span>
      <span>{count}</span>
    </div>
  );
}

function ListRow({
  avatar,
  name,
  subtitle,
  online,
  onClick,
  active = false,
}: {
  avatar: React.ReactNode;
  name: string;
  subtitle?: string;
  online?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        active
          ? "bg-neon-cyan/10"
          : "hover:bg-glass-bg/60"
      }`}
    >
      <div className="relative shrink-0">
        {avatar}
        {online !== undefined ? (
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-deep-black-light ${
              online ? "bg-neon-green" : "bg-text-secondary/40"
            }`}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-text-primary">{name}</div>
        {subtitle ? (
          <div className="truncate text-[11px] text-text-secondary/60">{subtitle}</div>
        ) : null}
      </div>
    </button>
  );
}

function Avatar({ seed, tone = "cyan" }: { seed: string; tone?: "cyan" | "purple" }) {
  const bg = tone === "purple"
    ? "border-neon-purple/25 bg-neon-purple/10 text-neon-purple"
    : "border-neon-cyan/25 bg-neon-cyan/10 text-neon-cyan";
  return (
    <div className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold ${bg}`}>
      {seed.charAt(0).toUpperCase()}
    </div>
  );
}

interface ContactsPanelProps {
  onOpenAddFriend?: () => void;
}

export default function ContactsPanel({ onOpenAddFriend }: ContactsPanelProps) {
  const router = useRouter();
  const t = contactsUiI18n[useLanguage()];
  const overview = useDashboardChatStore((s) => s.overview);
  const humanRooms = useDashboardSessionStore((s) => s.humanRooms);
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const { setSidebarTab, setContactsView, selectedContactKey, setSelectedContactKey } = useDashboardUIStore(useShallow((s) => ({
    setSidebarTab: s.setSidebarTab,
    setContactsView: s.setContactsView,
    selectedContactKey: s.selectedContactKey,
    setSelectedContactKey: s.setSelectedContactKey,
  })));
  const { contactRequestsReceived } = useDashboardContactStore(useShallow((s) => ({
    contactRequestsReceived: s.contactRequestsReceived,
  })));

  const pending = contactRequestsReceived.filter((r) => r.state === "pending");
  const contacts = overview?.contacts || [];
  const ownedAgentIds = new Set(ownedAgents.map((a) => a.agent_id));
  // Owned bots are listed separately at the top; drop them from the contact list
  // to avoid the same name showing twice.
  const agentContacts = contacts.filter(
    (c) => (c.peer_type ?? "agent") === "agent" && !ownedAgentIds.has(c.contact_agent_id),
  );
  const humanContacts = contacts.filter((c) => c.peer_type === "human");
  const rooms = overview?.rooms || humanRooms || [];
  const groups = rooms.filter((r) => (r.member_count ?? 0) > 2);

  const openRequests = () => {
    setContactsView("requests");
    setSidebarTab("contacts");
    setSelectedContactKey(null);
    startTransition(() => router.push("/chats/contacts/requests"));
  };

  const selectAgent = (id: string) => setSelectedContactKey({ type: "agent", id });
  const selectHuman = (id: string) => setSelectedContactKey({ type: "human", id });
  const selectGroup = (id: string) => setSelectedContactKey({ type: "group", id });

  const isActive = (type: "agent" | "human" | "group", id: string) =>
    selectedContactKey?.type === type && selectedContactKey.id === id;

  if (!overview) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-glass-border px-3 py-3">
          <SkeletonBlock className="h-10 w-10 rounded-full" />
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-3.5 w-32" />
            <SkeletonBlock className="mt-2 h-2.5 w-24 bg-glass-border/40" />
          </div>
        </div>
        <SidebarListSkeleton rows={9} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Pinned: New Requests */}
      <button
        onClick={openRequests}
        className="flex items-center gap-3 border-b border-glass-border px-3 py-3 text-left transition-colors hover:bg-glass-bg/60"
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-500/15 text-orange-400">
          <UserPlus2 className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{t.newRequests}</span>
            {pending.length > 0 ? (
              <span className="rounded-full bg-neon-cyan px-1.5 text-[10px] font-bold text-black">
                {pending.length}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[11px] text-text-secondary/60">
            {pending.length > 0
              ? t.pendingRequests(pending.length)
              : t.noPendingRequests}
          </p>
        </div>
      </button>

      <div className="flex-1 overflow-y-auto">
        {/* Agents */}
        <Section title={t.agentsGroup} count={ownedAgents.length + agentContacts.length}>
          {/* Sub-group: my owned bots */}
          {ownedAgents.length > 0 ? (
            <SubGroupHeader title={t.myBotGroup} count={ownedAgents.length} />
          ) : null}
          {ownedAgents.map((agent) => (
            <ListRow
              key={`owned-${agent.agent_id}`}
              avatar={<BotAvatar agentId={agent.agent_id} size={32} alt={agent.display_name} />}
              name={agent.display_name}
              subtitle={agent.is_default ? t.myBotSubtitleDefault : t.myBotSubtitle}
              online={agent.ws_online}
              active={isActive("agent", agent.agent_id)}
              onClick={() => selectAgent(agent.agent_id)}
            />
          ))}
          {/* Sub-group: external bot contacts */}
          {agentContacts.length > 0 ? (
            <SubGroupHeader title={t.externalBotGroup} count={agentContacts.length} />
          ) : null}
          {agentContacts.map((c) => (
            <ListRow
              key={`agent-${c.contact_agent_id}`}
              avatar={<BotAvatar agentId={c.contact_agent_id} size={32} alt={c.display_name} />}
              name={c.alias || c.display_name}
              subtitle={c.alias ? c.display_name : c.contact_agent_id}
              online={c.online}
              active={isActive("agent", c.contact_agent_id)}
              onClick={() => selectAgent(c.contact_agent_id)}
            />
          ))}
          {ownedAgents.length === 0 && agentContacts.length === 0 ? (
            <p className="px-3 py-3 text-xs text-text-secondary/50">{t.noAgentsYet}</p>
          ) : null}
        </Section>

        {/* Humans */}
        <Section title={t.humansGroup} count={humanContacts.length}>
          {humanContacts.length === 0 ? (
            <p className="px-3 py-3 text-xs text-text-secondary/50">{t.noHumanContactsYet}</p>
          ) : (
            humanContacts.map((c) => (
              <ListRow
                key={`human-${c.contact_agent_id}`}
                avatar={<Avatar seed={c.display_name} tone="purple" />}
                name={c.alias || c.display_name}
                subtitle={c.contact_agent_id}
                online={c.online}
                active={isActive("human", c.contact_agent_id)}
                onClick={() => selectHuman(c.contact_agent_id)}
              />
            ))
          )}
        </Section>

        {/* Groups */}
        <Section title={t.groupsGroup} count={groups.length}>
          {groups.length === 0 ? (
            <p className="px-3 py-3 text-xs text-text-secondary/50">{t.noGroupsJoined}</p>
          ) : (
            groups.map((room) => (
              <ListRow
                key={room.room_id}
                avatar={
                  room.members_preview && room.members_preview.length >= 2 ? (
                    <CompositeAvatar
                      members={room.members_preview}
                      totalMembers={room.member_count ?? room.members_preview.length}
                      size={32}
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-neon-cyan/25 bg-neon-cyan/10 text-neon-cyan">
                      <Users className="h-3.5 w-3.5" />
                    </div>
                  )
                }
                name={room.name}
                subtitle={t.memberCount(room.member_count ?? 0)}
                active={isActive("group", room.room_id)}
                onClick={() => selectGroup(room.room_id)}
              />
            ))
          )}
        </Section>

        {/* Invite-friend action moved to the panel header (top-right). */}
      </div>
    </div>
  );
}
