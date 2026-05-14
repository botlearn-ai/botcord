"use client";

import { useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { MessageCircle, Settings2, Share2, SlidersHorizontal, UserCircle, Users } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useLanguage } from "@/lib/i18n";
import { contactsUi as contactsUiI18n } from "@/lib/i18n/translations/dashboard";
import type { DashboardRoom, ContactInfo, HumanRoomSummary, UserAgent } from "@/lib/types";
import { CompositeAvatar } from "./CompositeAvatar";
import BotAvatar from "./BotAvatar";

type ResolvedTarget =
  | { kind: "owned-bot"; agent: UserAgent }
  | { kind: "agent-contact"; contact: ContactInfo }
  | { kind: "human-contact"; contact: ContactInfo }
  | { kind: "group"; room: DashboardRoom | HumanRoomSummary }
  | null;

function resolveTarget(
  key: { type: "agent" | "human" | "group"; id: string } | null,
  ownedAgents: UserAgent[],
  contacts: ContactInfo[],
  rooms: Array<DashboardRoom | HumanRoomSummary>,
): ResolvedTarget {
  if (!key) return null;
  if (key.type === "agent") {
    const owned = ownedAgents.find((a) => a.agent_id === key.id);
    if (owned) return { kind: "owned-bot", agent: owned };
    const contact = contacts.find((c) => c.contact_agent_id === key.id && (c.peer_type ?? "agent") === "agent");
    if (contact) return { kind: "agent-contact", contact };
    return null;
  }
  if (key.type === "human") {
    const contact = contacts.find((c) => c.contact_agent_id === key.id && c.peer_type === "human");
    if (contact) return { kind: "human-contact", contact };
    return null;
  }
  const room = rooms.find((r) => r.room_id === key.id);
  return room ? { kind: "group", room } : null;
}

function Tag({ tone, children }: { tone: "cyan" | "gray" | "green"; children: React.ReactNode }) {
  const cls =
    tone === "gray"
      ? "border-text-secondary/20 bg-text-secondary/10 text-text-secondary/70"
      : tone === "green"
        ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
        : "border-neon-cyan/40 bg-neon-cyan/15 text-neon-cyan";
  return (
    <span className={`rounded-full border px-2 py-px text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

function BigAvatar({ seed, tone = "cyan" }: { seed: string; tone?: "cyan" | "purple" }) {
  const cls =
    tone === "purple"
      ? "border-neon-purple/25 bg-neon-purple/10 text-neon-purple"
      : "border-neon-cyan/25 bg-neon-cyan/10 text-neon-cyan";
  return (
    <div className={`flex h-24 w-24 items-center justify-center rounded-3xl border text-3xl font-semibold ${cls}`}>
      {(seed || "?").charAt(0).toUpperCase()}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "neutral" | "cyan";
}) {
  const cls =
    tone === "cyan"
      ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20"
      : "border-glass-border bg-glass-bg text-text-primary hover:border-neon-cyan/40 hover:text-neon-cyan";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-20 w-28 flex-col items-center justify-center gap-2 rounded-2xl border transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${cls}`}
    >
      <Icon className="h-5 w-5" />
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

export default function ContactsDetailPane() {
  const router = useRouter();
  const t = contactsUiI18n[useLanguage()];
  const [messageBusy, setMessageBusy] = useState(false);
  const selectedContactKey = useDashboardUIStore((s) => s.selectedContactKey);
  const setBotDetailAgentId = useDashboardUIStore((s) => s.setBotDetailAgentId);
  const setPeerBotAgentId = useDashboardUIStore((s) => s.setPeerBotAgentId);
  const {
    setFocusedRoomId,
    setOpenedRoomId,
    setMessagesPane,
    setUserChatAgentId,
    setUserChatRoomId,
    startPrimaryNavigation,
  } = useDashboardUIStore(useShallow((s) => ({
    setFocusedRoomId: s.setFocusedRoomId,
    setOpenedRoomId: s.setOpenedRoomId,
    setMessagesPane: s.setMessagesPane,
    setUserChatAgentId: s.setUserChatAgentId,
    setUserChatRoomId: s.setUserChatRoomId,
    startPrimaryNavigation: s.startPrimaryNavigation,
  })));
  const { ownedAgents, humanRooms, activeAgentId, refreshHumanRooms } = useDashboardSessionStore(
    useShallow((s) => ({
      ownedAgents: s.ownedAgents,
      humanRooms: s.humanRooms,
      activeAgentId: s.activeAgentId,
      refreshHumanRooms: s.refreshHumanRooms,
    })),
  );
  const { overview, publicAgents, refreshOverview, loadRoomMessages, setError, switchActiveAgent } = useDashboardChatStore(
    useShallow((s) => ({
      overview: s.overview,
      publicAgents: s.publicAgents,
      refreshOverview: s.refreshOverview,
      loadRoomMessages: s.loadRoomMessages,
      setError: s.setError,
      switchActiveAgent: s.switchActiveAgent,
    })),
  );

  const contacts = overview?.contacts || [];
  const rooms: Array<DashboardRoom | HumanRoomSummary> = overview?.rooms ?? humanRooms ?? [];
  const target = resolveTarget(selectedContactKey, ownedAgents, contacts, rooms);

  if (!target) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center bg-deep-black px-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-glass-border bg-glass-bg/40">
            <UserCircle className="h-6 w-6 text-neon-cyan/80" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">{t.emptyTitle}</h2>
          <p className="mt-2 text-sm text-text-secondary/70">
            {t.emptyDescription}
          </p>
        </div>
      </div>
    );
  }

  // --- Resolve display fields per target type ---
  let title = "";
  let subtitle = "";
  let tag: { tone: "cyan" | "gray"; label: string } | null = null;
  let statusText = "";
  let avatar: React.ReactNode;
  let bio: string | null = null;

  if (target.kind === "owned-bot") {
    const a = target.agent;
    title = a.display_name;
    subtitle = a.agent_id;
    tag = { tone: "cyan", label: a.is_default ? t.myBotTagDefault : t.myBot };
    statusText = a.ws_online ? "● Online" : "● Offline";
    bio = a.bio ?? null;
    avatar = <BotAvatar agentId={a.agent_id} size={96} alt={a.display_name} />;
  } else if (target.kind === "agent-contact") {
    const c = target.contact;
    title = c.alias || c.display_name;
    subtitle = c.contact_agent_id;
    const ownerName = publicAgents.find((a) => a.agent_id === c.contact_agent_id)?.owner_display_name;
    tag = { tone: "gray", label: ownerName ? t.ownedBotOf(ownerName) : t.externalBot };
    statusText = c.online ? "● Online" : "● Offline";
    avatar = <BotAvatar agentId={c.contact_agent_id} size={96} alt={c.display_name} />;
  } else if (target.kind === "human-contact") {
    const c = target.contact;
    title = c.alias || c.display_name;
    subtitle = c.contact_agent_id;
    tag = { tone: "gray", label: "HUMAN" };
    statusText = c.online ? "● Online" : "● Offline";
    avatar = <BigAvatar seed={c.display_name} tone="purple" />;
  } else {
    // group
    const r = target.room;
    title = r.name;
    subtitle = r.room_id;
    tag = { tone: "cyan", label: "GROUP" };
    statusText = t.memberCount(r.member_count ?? 0);
    bio = r.description || r.rule || null;
    const membersPreview = r.members_preview ?? [];
    avatar = membersPreview.length >= 2 ? (
      <div className="flex h-24 w-24 items-center justify-center">
        <CompositeAvatar
          members={membersPreview}
          totalMembers={r.member_count ?? membersPreview.length}
          size={88}
        />
      </div>
    ) : (
      <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-neon-cyan/25 bg-neon-cyan/10 text-neon-cyan">
        <Users className="h-9 w-9" />
      </div>
    );
  }

  const openRoomPath = (roomId: string) => {
    setMessagesPane("room");
    setUserChatAgentId(null);
    setFocusedRoomId(roomId);
    setOpenedRoomId(roomId);
    const path = `/chats/messages/${encodeURIComponent(roomId)}`;
    startPrimaryNavigation("messages", path);
    router.push(path);
  };

  const handleMessage = async () => {
    if (messageBusy) return;
    setMessageBusy(true);
    try {
      if (target.kind === "owned-bot") {
        const agentId = target.agent.agent_id;
        if (agentId !== activeAgentId) {
          await switchActiveAgent(agentId);
        }
        const room = await api.getUserChatRoom(agentId);
        setMessagesPane("user-chat");
        setUserChatAgentId(agentId);
        setUserChatRoomId(room.room_id);
        setFocusedRoomId(null);
        setOpenedRoomId(null);
        const path = `/chats/messages/${encodeURIComponent(room.room_id)}`;
        startPrimaryNavigation("messages", path);
        router.push(path);
        return;
      }

      if (target.kind === "group") {
        openRoomPath(target.room.room_id);
        return;
      }

      const peerId = target.contact.contact_agent_id;
      const room = await api.openDmRoom(peerId);
      await Promise.allSettled([
        refreshOverview(),
        refreshHumanRooms(),
      ]);
      openRoomPath(room.room_id);
      loadRoomMessages(room.room_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open conversation";
      console.error("[ContactsDetailPane] open message failed:", error);
      setError(message);
    } finally {
      setMessageBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-deep-black">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        {avatar}
        <div className="mt-5 flex items-center gap-2">
          <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
          {tag ? <Tag tone={tag.tone}>{tag.label}</Tag> : null}
        </div>
        <p className="mt-2 text-sm text-text-secondary/70">
          <span className={statusText.startsWith("●") && statusText.includes("Online") ? "text-neon-green" : ""}>
            {statusText}
          </span>
        </p>
        {subtitle ? (
          <p className="mt-1 font-mono text-[11px] text-text-secondary/55">{subtitle}</p>
        ) : null}
        {bio ? (
          <p className="mt-5 max-w-md text-center text-sm text-text-secondary/80">{bio}</p>
        ) : null}

        <div className="mt-8 flex items-center gap-3">
          <ActionButton
            icon={MessageCircle}
            label={messageBusy ? t.openingMessage : t.message}
            tone="cyan"
            onClick={handleMessage}
            disabled={messageBusy}
          />
          {target.kind === "owned-bot" ? (
            <ActionButton
              icon={SlidersHorizontal}
              label={t.viewDetails}
              onClick={() => setBotDetailAgentId(target.agent.agent_id)}
            />
          ) : target.kind === "agent-contact" ? (
            <ActionButton
              icon={SlidersHorizontal}
              label={t.viewDetails}
              onClick={() => setPeerBotAgentId(target.contact.contact_agent_id)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
