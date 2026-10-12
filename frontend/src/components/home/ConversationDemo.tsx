"use client";

import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Tabs from "@/components/ui/Tabs";
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import SectionHeading from "@/components/ui/SectionHeading";
import {
  scenarios,
  type AgentColor,
  type ConversationMessage,
  type Scenario,
} from "@/data/conversation-script";
import { useLanguage } from "@/lib/i18n";
import { conversationDemo, scenarioLabels } from "@/lib/i18n/translations/home";

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
  return <Avatar kind="agent" id={`demo-${color}-${label}`} name={label} size="sm" />;
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
      className={`flex gap-3 ${isLeft ? "flex-row" : "flex-row-reverse"}`} >
      <AgentAvatar color={agent.color} label={agent.label} />

      <div className="max-w-[75%] space-y-2">
        <Card padding="sm">
          <Badge>{typeLabel}</Badge>
          <p className="text-sm leading-relaxed text-text-primary">
            {msg.text}
          </p>
          {msg.payload && (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-deep-black/60 p-3 font-mono text-xs leading-relaxed text-text-secondary">
              {JSON.stringify(msg.payload, null, 2)}
            </pre>
          )}
        </Card>
      </div>
    </motion.div>
  );
}

/* ── Tab Bar ── */
function TabBar({
  scenarios: items,
  activeId,
  onSelect,
  labelMap,
}: {
  scenarios: Scenario[];
  activeId: string;
  onSelect: (id: string) => void;
  labelMap: Record<string, string>;
}) {
  return <Tabs value={activeId} onValueChange={onSelect} ariaLabel="Conversation scenarios" variant="underline" items={items.map((item) => ({ value: item.id, label: labelMap[item.id] || item.label }))} className="mb-6" />;
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

  const locale = useLanguage();
  const t = conversationDemo[locale];
  const sl = scenarioLabels[locale];

  const labelMap: Record<string, string> = {
    sentiment: sl.sentiment,
    delegation: sl.delegation,
    handshake: sl.handshake,
    broadcast: sl.broadcast,
  };

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
          title={t.title}
          subtitle={t.subtitle}
        />

        {/* Tab bar */}
        <TabBar
          scenarios={scenarios}
          activeId={activeScenarioId}
          onSelect={handleTabSelect}
          labelMap={labelMap}
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
                  <p className="font-mono text-xs text-text-secondary">
                    {a.shortId}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Conversation container — key forces remount on scenario change */}
        <Card padding="none">
          <div
            ref={scrollRef}
            key={activeScenarioId}
            className="flex max-h-[480px] min-h-[320px] flex-col gap-4 overflow-y-auto p-6" >
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
                className={`flex gap-3 ${typingAgent === "left" ? "flex-row" : "flex-row-reverse"}`} >
                <AgentAvatar
                  color={activeScenario.agents[typingAgent].color}
                  label={activeScenario.agents[typingAgent].label}
                />
                <Card padding="none">
                  <TypingIndicator
                    color={activeScenario.agents[typingAgent].color}
                  />
                </Card>
              </div>
            )}
          </div>
        </Card>

        {/* Footer note */}
        <p className="mt-4 text-center font-mono text-xs text-text-secondary">
          {t.footerNote}
        </p>
      </div>
    </section>
  );
}
