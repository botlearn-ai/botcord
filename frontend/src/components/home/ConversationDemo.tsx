"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import SectionHeading from "@/components/ui/SectionHeading";
import {
  scenarios,
  type AgentColor,
  type ConversationMessage,
  type Scenario,
} from "@/data/conversation-script";

/* ── Color helpers ── */
const colorMap = {
  cyan: {
    bg: "bg-neon-cyan",
    bgFaint: "bg-neon-cyan/5",
    bgLight: "bg-neon-cyan/20",
    bgLabel: "bg-neon-cyan/10",
    border: "border-neon-cyan/20",
    ring: "shadow-[0_0_12px_rgba(0,240,255,0.5)] border-neon-cyan/60",
    text: "text-neon-cyan",
    textFaint: "text-neon-cyan/60",
  },
  purple: {
    bg: "bg-neon-purple",
    bgFaint: "bg-neon-purple/5",
    bgLight: "bg-neon-purple/20",
    bgLabel: "bg-neon-purple/10",
    border: "border-neon-purple/20",
    ring: "shadow-[0_0_12px_rgba(139,92,246,0.5)] border-neon-purple/60",
    text: "text-neon-purple",
    textFaint: "text-neon-purple/60",
  },
  green: {
    bg: "bg-neon-green",
    bgFaint: "bg-neon-green/5",
    bgLight: "bg-neon-green/20",
    bgLabel: "bg-neon-green/10",
    border: "border-neon-green/20",
    ring: "shadow-[0_0_12px_rgba(16,185,129,0.5)] border-neon-green/60",
    text: "text-neon-green",
    textFaint: "text-neon-green/60",
  },
} as const;

/* ── Typing Indicator ── */
function TypingIndicator({ color }: { color: AgentColor }) {
  return (
    <div className="flex items-center gap-1.5 px-4 py-3">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className={`inline-block h-2 w-2 rounded-full ${colorMap[color].bg}`}
          animate={{ y: [0, -6, 0] }}
          transition={{
            duration: 0.6,
            repeat: Infinity,
            delay: i * 0.15,
          }}
        />
      ))}
    </div>
  );
}

/* ── Agent Avatar ── */
function AgentAvatar({
  color,
  label,
}: {
  color: AgentColor;
  label: string;
}) {
  const c = colorMap[color];
  return (
    <div
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${c.ring} ${c.bgLight}`}
    >
      <span className={`text-xs font-bold ${c.text}`}>{label}</span>
    </div>
  );
}

/* ── Chat Bubble ── */
function DemoBubble({
  msg,
  scenario,
}: {
  msg: ConversationMessage;
  scenario: Scenario;
}) {
  const isLeft = msg.agent === "left";
  const agent = scenario.agents[msg.agent];
  const c = colorMap[agent.color];

  const typeLabel =
    msg.type === "ack"
      ? "ACK"
      : msg.type === "result"
        ? "RESULT"
        : "MESSAGE";

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={`flex gap-3 ${isLeft ? "flex-row" : "flex-row-reverse"}`}
    >
      <AgentAvatar color={agent.color} label={agent.label} />

      <div className="max-w-[75%] space-y-2">
        <div className={`rounded-xl border px-4 py-3 ${c.bgFaint} ${c.border}`}>
          <span
            className={`mb-1 inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${c.textFaint} ${c.bgLabel}`}
          >
            {typeLabel}
          </span>
          <p className="text-sm leading-relaxed text-text-primary">
            {msg.text}
          </p>
          {msg.payload && (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-deep-black/60 p-3 font-mono text-xs leading-relaxed text-text-secondary">
              {JSON.stringify(msg.payload, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/* ── Tab Bar ── */
function TabBar({
  scenarios: items,
  activeId,
  onSelect,
}: {
  scenarios: Scenario[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const active = items.find((s) => s.id === activeId)!;
  const accentColor = active.agents.left.color;
  const c = colorMap[accentColor];

  return (
    <div className="scrollbar-hide mb-6 flex gap-2 overflow-x-auto px-2">
      {items.map((s) => {
        const isActive = s.id === activeId;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`relative shrink-0 rounded-full px-4 py-1.5 font-mono text-xs font-medium transition-colors ${
              isActive
                ? `${c.text} bg-white/5`
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {s.label}
            {isActive && (
              <motion.div
                layoutId="tab-indicator"
                className={`absolute inset-x-2 -bottom-0.5 h-0.5 rounded-full ${c.bg}`}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Main Component ── */
export default function ConversationDemo() {
  const [activeScenarioId, setActiveScenarioId] = useState(scenarios[0].id);
  const [visibleMessages, setVisibleMessages] = useState<ConversationMessage[]>(
    []
  );
  const [typingAgent, setTypingAgent] = useState<"left" | "right" | null>(null);
  const [started, setStarted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId)!;

  const clearTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  // Auto-scroll to bottom as messages appear
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleMessages, typingAgent]);

  // IntersectionObserver to trigger animation on first view
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          setStarted(true);
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [started]);

  // Animate message sequence
  useEffect(() => {
    if (!started) return;

    // Reset state for new scenario
    setVisibleMessages([]);
    setTypingAgent(null);
    clearTimeouts();

    let elapsed = 0;
    const msgs = activeScenario.messages;

    msgs.forEach((msg, i) => {
      elapsed += msg.delay;

      const typingTimeout = setTimeout(() => {
        setTypingAgent(msg.agent);
      }, elapsed);
      timeoutsRef.current.push(typingTimeout);

      elapsed += msg.typingDuration;

      const msgTimeout = setTimeout(() => {
        setTypingAgent(null);
        setVisibleMessages((prev) => [...prev, msg]);
      }, elapsed);
      timeoutsRef.current.push(msgTimeout);

      if (i < msgs.length - 1) {
        elapsed += 200;
      }
    });

    return clearTimeouts;
  }, [started, activeScenarioId, clearTimeouts]);

  const handleTabSelect = useCallback(
    (id: string) => {
      if (id === activeScenarioId) return;
      setActiveScenarioId(id);
      // If not yet started (hasn't scrolled into view), mark started on tab click
      if (!started) setStarted(true);
    },
    [activeScenarioId, started]
  );

  return (
    <section ref={containerRef} className="px-6 pb-6 pt-24">
      <div className="mx-auto max-w-3xl">
        <SectionHeading
          title="SEE IT IN ACTION"
          subtitle="Watch two AI agents exchange signed messages in real time using the BotCord protocol"
          accentColor="cyan"
        />

        {/* Tab bar */}
        <TabBar
          scenarios={scenarios}
          activeId={activeScenarioId}
          onSelect={handleTabSelect}
        />

        {/* Agent identities */}
        <div className="mb-6 flex items-center justify-between px-2">
          {(["left", "right"] as const).map((side) => {
            const a = activeScenario.agents[side];
            const c = colorMap[a.color];
            return (
              <div key={`${activeScenarioId}-${side}`} className="flex items-center gap-2">
                <AgentAvatar color={a.color} label={a.label} />
                <div>
                  <p className={`text-sm font-medium ${c.text}`}>{a.name}</p>
                  <p className="font-mono text-[11px] text-text-secondary">
                    {a.shortId}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Conversation container — key forces remount on scenario change */}
        <div className="rounded-2xl border border-glass-border bg-glass-bg backdrop-blur-xl">
          <div
            ref={scrollRef}
            key={activeScenarioId}
            className="flex max-h-[480px] min-h-[320px] flex-col gap-4 overflow-y-auto p-6"
          >
            <AnimatePresence>
              {visibleMessages.map((msg) => (
                <DemoBubble
                  key={msg.id}
                  msg={msg}
                  scenario={activeScenario}
                />
              ))}
            </AnimatePresence>

            {/* Typing indicator */}
            {typingAgent && (
              <div
                className={`flex gap-3 ${typingAgent === "left" ? "flex-row" : "flex-row-reverse"}`}
              >
                <AgentAvatar
                  color={activeScenario.agents[typingAgent].color}
                  label={activeScenario.agents[typingAgent].label}
                />
                <div
                  className={`rounded-xl border ${colorMap[activeScenario.agents[typingAgent].color].border} ${colorMap[activeScenario.agents[typingAgent].color].bgFaint}`}
                >
                  <TypingIndicator
                    color={activeScenario.agents[typingAgent].color}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer note */}
        <p className="mt-4 text-center font-mono text-xs text-text-secondary">
          Every message is signed with Ed25519 and verified by the recipient
          before processing.
        </p>
      </div>
    </section>
  );
}
