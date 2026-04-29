"use client";

import { useState, useMemo } from "react";
import { Check, Loader2, MessageSquare, Search, Users, User, X } from "lucide-react";
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useShallow } from "zustand/react/shallow";

interface ForwardTarget {
  id: string;
  kind: "agent" | "room" | "contact";
  label: string;
  sublabel?: string;
}

interface ForwardModalProps {
  quoteText: string;
  onClose: () => void;
}

export default function ForwardModal({ quoteText, onClose }: ForwardModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

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

  const targets = useMemo(() => {
    if (!query.trim()) return allTargets;
    const q = query.toLowerCase();
    return allTargets.filter(
      (t) => t.label.toLowerCase().includes(q) || t.sublabel?.toLowerCase().includes(q)
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, allTargets.length]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSend = async () => {
    if (selected.size === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await Promise.all(
        [...selected].map(async (targetId) => {
          const [kind, id] = targetId.split(":") as ["agent" | "contact" | "room", string];
          if (kind === "agent") {
            await api.sendUserChatMessage(quoteText, undefined, id);
          } else if (kind === "contact") {
            // find DM room for this contact
            const dmRoom = overview?.rooms?.find(
              (r) => r.room_id.startsWith("rm_dm_") && r.room_id.includes(id)
            );
            if (dmRoom) {
              await api.sendRoomHumanMessage(dmRoom.room_id, quoteText);
            }
          } else {
            await api.sendRoomHumanMessage(id, quoteText);
          }
        })
      );
      setDone(true);
      setTimeout(onClose, 800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "发送失败");
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <span className="text-sm font-medium text-zinc-200">转发消息</span>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="relative mx-4 mt-3">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索联系人或群..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-cyan-500/50 focus:outline-none"
            autoFocus
          />
        </div>

        {/* Quote preview */}
        <div className="mx-4 mt-3 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2">
          <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-zinc-400 leading-relaxed">
            {quoteText}
          </pre>
        </div>

        {/* Target list */}
        <div className="max-h-64 overflow-y-auto px-4 py-2 space-y-1">
          {targets.length === 0 && (
            <p className="py-6 text-center text-xs text-zinc-500">暂无可用目标</p>
          )}
          {targets.map((t) => {
            const isSelected = selected.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(t.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                  isSelected ? "bg-cyan-500/15 text-cyan-200" : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {t.kind === "room" ? (
                  <Users className="h-3.5 w-3.5 shrink-0 text-neon-purple/70" />
                ) : t.kind === "agent" ? (
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-neon-cyan/70" />
                ) : (
                  <User className="h-3.5 w-3.5 shrink-0 text-neon-green/70" />
                )}
                <span className="flex-1 truncate text-xs font-medium">{t.label}</span>
                {t.sublabel && (
                  <span className="shrink-0 font-mono text-[10px] text-zinc-500 truncate max-w-[100px]">{t.sublabel}</span>
                )}
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-cyan-400" />}
              </button>
            );
          })}
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
