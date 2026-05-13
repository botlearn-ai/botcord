"use client";

import { useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { MessageCircle, Settings2, Share2, UserCircle, Users } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { humanRoomToDashboardRoom } from "@/store/dashboard-shared";
import type { DashboardRoom, ContactInfo, UserAgent } from "@/lib/types";
import { CompositeAvatar } from "./CompositeAvatar";
import BotAvatar from "./BotAvatar";
import AgentSettingsDrawer from "./AgentSettingsDrawer";

type ResolvedTarget =
  | { kind: "owned-bot"; agent: UserAgent }
  | { kind: "agent-contact"; contact: ContactInfo }
  | { kind: "human-contact"; contact: ContactInfo }
  | { kind: "group"; room: DashboardRoom }
  | null;

function resolveTarget(
  key: { type: "agent" | "human" | "group"; id: string } | null,
  ownedAgents: UserAgent[],
  contacts: ContactInfo[],
  rooms: DashboardRoom[],
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

function Tag({ tone, children }: { tone: "cyan" | "purple" | "green"; children: React.ReactNode }) {
  const cls =
    tone === "purple"
      ? "border-neon-purple/40 bg-neon-purple/10 text-neon-purple"
      : tone === "green"
        ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
        : "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan";
  return (
    <span className={`rounded-full border px-2 py-px text-[10px] font-medium uppercase tracking-[0.12em] ${cls}`}>
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
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  tone?: "neutral" | "cyan";
}) {
  const cls =
    tone === "cyan"
      ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20"
      : "border-glass-border bg-glass-bg text-text-primary hover:border-neon-cyan/40 hover:text-neon-cyan";
  return (
    <button
      onClick={onClick}
      className={`flex h-20 w-28 flex-col items-center justify-center gap-2 rounded-2xl border transition-colors ${cls}`}
    >
      <Icon className="h-5 w-5" />
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

export default function ContactsDetailPane() {
  const router = useRouter();
  const [settingsAgent, setSettingsAgent] = useState<UserAgent | null>(null);
  const selectedContactKey = useDashboardUIStore((s) => s.selectedContactKey);
  const { ownedAgents, humanRooms } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents, humanRooms: s.humanRooms })),
  );
  const overview = useDashboardChatStore((s) => s.overview);

  const contacts = overview?.contacts || [];
  const rooms = overview?.rooms || humanRooms.map(humanRoomToDashboardRoom);
  const target = resolveTarget(selectedContactKey, ownedAgents, contacts, rooms);

  if (!target) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center bg-deep-black px-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-glass-border bg-glass-bg/40">
            <UserCircle className="h-6 w-6 text-neon-cyan/80" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">从左侧选一个联系人</h2>
          <p className="mt-2 text-sm text-text-secondary/70">
            选择一个 Bot、真人或群聊，在这里查看资料并发起对话。
          </p>
        </div>
      </div>
    );
  }

  // --- Resolve display fields per target type ---
  let title = "";
  let subtitle = "";
  let tag: { tone: "cyan" | "purple"; label: string } | null = null;
  let statusText = "";
  let avatar: React.ReactNode;
  let bio: string | null = null;
  let messageRoomId: string | null = null;

  if (target.kind === "owned-bot") {
    const a = target.agent;
    title = a.display_name;
    subtitle = a.agent_id;
    tag = { tone: "cyan", label: "BOT" };
    statusText = a.ws_online ? "● Online" : "● Offline";
    bio = a.bio ?? null;
    avatar = <BotAvatar agentId={a.agent_id} avatarUrl={a.avatar_url} size={96} alt={a.display_name} />;
  } else if (target.kind === "agent-contact") {
    const c = target.contact;
    title = c.alias || c.display_name;
    subtitle = c.contact_agent_id;
    tag = { tone: "cyan", label: "BOT" };
    statusText = c.online ? "● Online" : "● Offline";
    avatar = <BotAvatar agentId={c.contact_agent_id} size={96} alt={c.display_name} />;
  } else if (target.kind === "human-contact") {
    const c = target.contact;
    title = c.alias || c.display_name;
    subtitle = c.contact_agent_id;
    tag = { tone: "purple", label: "HUMAN" };
    statusText = c.online ? "● Online" : "● Offline";
    avatar = <BigAvatar seed={c.display_name} tone="purple" />;
  } else {
    // group
    const r = target.room;
    title = r.name;
    subtitle = r.room_id;
    tag = { tone: "cyan", label: "GROUP" };
    statusText = `${r.member_count ?? 0} 成员`;
    bio = r.description || r.rule || null;
    messageRoomId = r.room_id;
    avatar = r.members_preview && r.members_preview.length >= 2 ? (
      <div className="flex h-24 w-24 items-center justify-center">
        <CompositeAvatar
          members={r.members_preview}
          totalMembers={r.member_count ?? r.members_preview.length}
          size={88}
        />
      </div>
    ) : (
      <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-neon-cyan/25 bg-neon-cyan/10 text-neon-cyan">
        <Users className="h-9 w-9" />
      </div>
    );
  }

  const handleMessage = () => {
    if (messageRoomId) {
      router.push(`/chats/messages/${encodeURIComponent(messageRoomId)}`);
      return;
    }
    router.push("/chats/messages");
  };

  const handleShare = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(subtitle || title);
    }
  };

  const handleSettings = () => {
    if (target.kind === "owned-bot") {
      setSettingsAgent(target.agent);
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
          <ActionButton icon={MessageCircle} label="Message" tone="cyan" onClick={handleMessage} />
          <ActionButton icon={Share2} label="Share" onClick={handleShare} />
          {target.kind === "owned-bot" ? (
            <ActionButton icon={Settings2} label="Settings" onClick={handleSettings} />
          ) : null}
        </div>
      </div>
      {settingsAgent ? (
        <AgentSettingsDrawer
          agentId={settingsAgent.agent_id}
          displayName={settingsAgent.display_name}
          bio={settingsAgent.bio ?? null}
          avatarUrl={settingsAgent.avatar_url ?? null}
          onClose={() => setSettingsAgent(null)}
          onSaved={() => setSettingsAgent(null)}
        />
      ) : null}
    </div>
  );
}
