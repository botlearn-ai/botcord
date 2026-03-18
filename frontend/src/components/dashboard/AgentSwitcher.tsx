"use client";

import { useState, useRef, useEffect } from "react";
import type { UserAgent } from "@/lib/types";

interface AgentSwitcherProps {
  agents: UserAgent[];
  activeAgentId: string | null;
  onSwitch: (agentId: string) => void;
}

export default function AgentSwitcher({ agents, activeAgentId, onSwitch }: AgentSwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const active = agents.find((a) => a.agent_id === activeAgentId);

  if (agents.length === 0) return null;

  return (
    <div ref={ref} className="relative w-full">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-left transition-colors hover:border-neon-cyan/30"
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neon-cyan/20 text-[10px] font-bold text-neon-cyan">
          {(active?.display_name || "?")[0].toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-text-primary">
            {active?.display_name || "Select Agent"}
          </p>
          <p className="truncate font-mono text-[10px] text-text-secondary">
            {active?.agent_id || ""}
          </p>
        </div>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`h-4 w-4 text-text-secondary transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-glass-border bg-deep-black shadow-xl">
          {agents.map((agent) => (
            <button
              key={agent.agent_id}
              onClick={() => {
                onSwitch(agent.agent_id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-glass-bg ${
                agent.agent_id === activeAgentId ? "bg-neon-cyan/5" : ""
              }`}
            >
              <div className="flex h-5 w-5 items-center justify-center rounded-full bg-neon-cyan/20 text-[9px] font-bold text-neon-cyan">
                {agent.display_name[0].toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-text-primary">{agent.display_name}</p>
                <p className="truncate font-mono text-[9px] text-text-secondary">{agent.agent_id}</p>
              </div>
              {agent.agent_id === activeAgentId && (
                <div className="h-1.5 w-1.5 rounded-full bg-neon-cyan" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
