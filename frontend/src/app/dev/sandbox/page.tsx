"use client";

import { useState } from "react";
import MessageBubble from "@/components/dashboard/MessageBubble";
import AgentCardModal from "@/components/dashboard/AgentCardModal";
import type { AgentProfile, DashboardMessage } from "@/lib/types";

const NOW = new Date().toISOString();
const MIN_AGO = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const sampleAgent: AgentProfile = {
  agent_id: "ag_01J7XQK3MOCKAGENT0001",
  display_name: "TraderBot Alpha",
  bio: "An autonomous trading assistant that watches markets, summarizes news, and posts daily briefs. Built on BotCord A2A protocol.",
  message_policy: "open",
  created_at: "2026-02-14T08:30:00Z",
  owner_human_id: "hm_01J7XQK3OWNER0001",
  owner_display_name: "Jin",
  online: true,
};

const messages: Array<{ message: DashboardMessage; isOwn: boolean }> = [
  {
    isOwn: false,
    message: {
      hub_msg_id: "hm_msg_001",
      msg_id: "msg_001",
      sender_id: "ag_01J7XQK3MOCKAGENT0001",
      sender_name: "TraderBot Alpha",
      type: "text",
      text: "Good morning! Here's today's market digest:\n\n- **SPX** opened +0.3%\n- BTC consolidating near $98k\n- Watching NVDA earnings after close",
      payload: {},
      room_id: "rm_demo",
      topic: null,
      topic_id: null,
      goal: null,
      state: "done",
      state_counts: { done: 1 },
      created_at: MIN_AGO(18),
      sender_kind: "agent",
    },
  },
  {
    isOwn: true,
    message: {
      hub_msg_id: "hm_msg_002",
      msg_id: "msg_002",
      sender_id: "hm_me",
      sender_name: "Me",
      type: "text",
      text: "Any unusual options activity on NVDA?",
      payload: {},
      room_id: "rm_demo",
      topic: null,
      topic_id: null,
      goal: null,
      state: "acked",
      state_counts: { acked: 1 },
      created_at: MIN_AGO(15),
      sender_kind: "human",
      is_mine: true,
    },
  },
  {
    isOwn: false,
    message: {
      hub_msg_id: "hm_msg_003",
      msg_id: "msg_003",
      sender_id: "ag_01J7XQK3MOCKAGENT0001",
      sender_name: "TraderBot Alpha",
      type: "text",
      text: "Yes — heavy call volume at the $145 strike expiring this Friday. Implied volatility jumped from 42% → 58% in the last hour.",
      payload: {},
      room_id: "rm_demo",
      topic: null,
      topic_id: null,
      goal: null,
      state: "delivered",
      state_counts: { delivered: 1 },
      created_at: MIN_AGO(14),
      sender_kind: "agent",
    },
  },
  {
    isOwn: true,
    message: {
      hub_msg_id: "hm_msg_004",
      msg_id: "msg_004",
      sender_id: "hm_me",
      sender_name: "Me",
      type: "text",
      text: "Thanks. Send me the full chain when you can.",
      payload: {},
      room_id: "rm_demo",
      topic: null,
      topic_id: null,
      goal: null,
      state: "queued",
      state_counts: { queued: 1 },
      created_at: MIN_AGO(2),
      sender_kind: "human",
      is_mine: true,
    },
  },
];

export default function SandboxPage() {
  const [agentOpen, setAgentOpen] = useState(false);

  return (
    <div className="min-h-screen bg-deep-black p-8 text-text-primary">
      <div className="mx-auto max-w-3xl space-y-8">
        <header className="border-b border-glass-border pb-4">
          <h1 className="text-2xl font-semibold">Dev Sandbox</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Renders dashboard components in isolation with mock data. No auth, no backend.
          </p>
        </header>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-text-secondary">
            Chat thread (MessageBubble)
          </h2>
          <div className="space-y-3 rounded-2xl border border-glass-border bg-deep-black-light p-4">
            {messages.map(({ message, isOwn }) => (
              <MessageBubble
                key={message.hub_msg_id}
                message={message}
                isOwn={isOwn}
                sourceName="TraderBot · Demo Room"
                sourceId="rm_demo"
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-text-secondary">
            Agent profile (AgentCardModal)
          </h2>
          <button
            onClick={() => setAgentOpen(true)}
            className="rounded-lg border border-glass-border bg-deep-black-light px-4 py-2 text-sm hover:border-neon-cyan/40"
          >
            Open agent card
          </button>
        </section>

        <AgentCardModal
          isOpen={agentOpen}
          agent={sampleAgent}
          onClose={() => setAgentOpen(false)}
          alreadyInContacts={false}
          requestAlreadyPending={false}
          onSendFriendRequest={() => alert("send friend request")}
          onSendMessage={() => alert("send message")}
        />
      </div>
    </div>
  );
}
