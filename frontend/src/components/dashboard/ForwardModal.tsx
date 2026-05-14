"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileArchive, Loader2, MessageSquare, Users, User, X } from "lucide-react";
import { api, getActiveIdentity } from "@/lib/api";
import type { Attachment } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import DashboardMultiSelect from "./DashboardMultiSelect";
import { useShallow } from "zustand/react/shallow";

interface ForwardTarget {
  id: string;
  kind: "agent" | "room" | "contact";
  label: string;
  sublabel?: string;
}

interface ForwardModalProps {
  quoteText: string;
  sourceFile?: {
    url: string;
    filename: string;
    contentType?: string;
    sizeBytes?: number;
  };
  onClose: () => void;
}

export default function ForwardModal({ quoteText, sourceFile, onClose }: ForwardModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { setOpenedRoomId } = useDashboardUIStore(useShallow((s) => ({ setOpenedRoomId: s.setOpenedRoomId })));

  const { ownedAgents, viewMode } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents, viewMode: s.viewMode }))
  );
  const overview = useDashboardChatStore((s) => s.overview);

  const allTargets: ForwardTarget[] = [
    ...(viewMode !== "agent"
      ? ownedAgents.map((a) => ({
          id: `agent:${a.agent_id}`,
          kind: "agent" as const,
          label: a.display_name,
          sublabel: a.agent_id,
        }))
      : []),
    ...(overview?.contacts ?? []).map((c) => ({
      id: `contact:${c.contact_agent_id}`,
      kind: "contact" as const,
      label: c.alias || c.display_name,
      sublabel: c.contact_agent_id,
    })),
    ...(overview?.rooms ?? [])
      .filter((r) => !r.room_id.startsWith("rm_oc_"))
      .map((r) => ({
        id: `room:${r.room_id}`,
        kind: "room" as const,
        label: r.name,
        sublabel: r.room_id,
      })),
  ];

  const handleSend = async () => {
    if (selected.size === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      let attachments: Attachment[] | undefined;
      if (sourceFile) {
        const activeIdentity = getActiveIdentity();
        const uploadAgentId =
          activeIdentity?.type === "agent"
            ? activeIdentity.id
            : ownedAgents[0]?.agent_id;
        if (!uploadAgentId) {
          throw new Error("Choose or create an agent before sending files.");
        }
        const res = await fetch(sourceFile.url, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to prepare file for sending");
        const blob = await res.blob();
        const file = new File([blob], sourceFile.filename, {
          type: sourceFile.contentType || blob.type || "application/zip",
        });
        const uploaded = await api.uploadFile(file, uploadAgentId);
        attachments = [{
          filename: uploaded.original_filename,
          url: uploaded.url,
          content_type: uploaded.content_type,
          size_bytes: uploaded.size_bytes,
        }];
      }
      const openRoomIds: string[] = [];
      await Promise.all(
        [...selected].map(async (targetId) => {
          const [kind, id] = targetId.split(":") as ["agent" | "contact" | "room", string];
          if (kind === "agent") {
            await api.sendUserChatMessage(quoteText, attachments, id);
          } else if (kind === "contact") {
            const dmRoom = await api.openDmRoom(id);
            await api.sendRoomHumanMessage(dmRoom.room_id, quoteText, undefined, undefined, attachments);
            openRoomIds.push(dmRoom.room_id);
          } else {
            await api.sendRoomHumanMessage(id, quoteText, undefined, undefined, attachments);
            openRoomIds.push(id);
          }
        })
      );
      setDone(true);
      // Navigate to the forwarded conversation — if exactly one room target, open it directly
      if (openRoomIds.length === 1) {
        const roomId = openRoomIds[0];
        setOpenedRoomId(roomId);
        router.push(`/chats/messages/${encodeURIComponent(roomId)}`);
      }
      setTimeout(onClose, 800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "发送失败");
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <span className="text-sm font-medium text-zinc-200">转发消息</span>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quote / file preview */}
        <div className="mx-4 mt-3 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2">
          {sourceFile ? (
            <div className="flex items-center gap-2 text-zinc-300">
              <FileArchive className="h-4 w-4 shrink-0 text-cyan-400" />
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{sourceFile.filename}</p>
                {sourceFile.sizeBytes != null && (
                  <p className="text-[10px] text-zinc-500">{sourceFile.sizeBytes} bytes</p>
                )}
              </div>
            </div>
          ) : (
            <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-zinc-400 leading-relaxed">
              {quoteText}
            </pre>
          )}
        </div>

        {/* Target selector */}
        <div className="px-4 py-3">
          <DashboardMultiSelect
            value={Array.from(selected)}
            onChange={(next) => setSelected(new Set(next))}
            placeholder="选择发送目标"
            searchPlaceholder="搜索联系人或房间..."
            emptyLabel="暂无可用目标"
            selectedLabel={(count) => (count > 0 ? `已选 ${count} 个` : "未选择")}
            groups={[
              {
                options: allTargets.map((target) => ({
                  value: target.id,
                  label: target.label,
                  sublabel: target.sublabel,
                  badge: target.kind === "room" ? "Room" : target.kind === "agent" ? "Bot" : "Contact",
                  tone: target.kind === "room" ? "purple" : target.kind === "agent" ? "cyan" : "green",
                  icon:
                    target.kind === "room" ? (
                      <Users className="h-3.5 w-3.5 text-neon-purple/70" />
                    ) : target.kind === "agent" ? (
                      <MessageSquare className="h-3.5 w-3.5 text-neon-cyan/70" />
                    ) : (
                      <User className="h-3.5 w-3.5 text-neon-green/70" />
                    ),
                })),
              },
            ]}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          {done && <p className="text-[11px] text-emerald-400">已发送</p>}
          {!error && !done && (
            <span className="text-[11px] text-zinc-500">
              {selected.size > 0 ? `已选 ${selected.size} 个` : "选择发送目标"}
            </span>
          )}
          <button
            type="button"
            disabled={selected.size === 0 || sending || done}
            onClick={handleSend}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs font-medium text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending && <Loader2 className="h-3 w-3 animate-spin" />}
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
