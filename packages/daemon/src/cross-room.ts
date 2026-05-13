/**
 * Cross-room digest — a short block listing other rooms the agent is
 * actively talking in, so a single turn isn't blind to parallel
 * conversations.
 *
 * Unlike the plugin version (which reads OpenClaw's per-session message
 * history via `runtime.subagent.getSessionMessages()`), the daemon doesn't
 * have access to the underlying CLI's transcript. We synthesize the digest
 * from the ActivityTracker's last-inbound preview instead — lower fidelity,
 * but works uniformly across Claude Code / Codex / Gemini.
 */
import type { ActivityEntry, ActivityTracker } from "./activity-tracker.js";

const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface DigestOptions {
  tracker: ActivityTracker;
  agentId: string;
  currentRoomId: string;
  currentTopic?: string | null;
  /** Time horizon for "active". Default 2 hours. */
  windowMs?: number;
  /** Cap on how many rooms appear in the digest. Default 5. */
  maxEntries?: number;
}

export function buildCrossRoomDigest(opts: DigestOptions): string | null {
  const {
    tracker,
    agentId,
    currentRoomId,
    currentTopic = null,
    windowMs = DEFAULT_WINDOW_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = opts;

  const excludeKey = tracker.keyFor(agentId, currentRoomId, currentTopic ?? null);
  const entries = tracker.listActive({ agentId, windowMs, excludeKey });
  if (entries.length === 0) return null;

  const slice = entries.slice(0, maxEntries);
  const total = entries.length + 1; // +1 for the current turn's room

  const lines: string[] = [
    "[BotCord Cross-Room Awareness]",
    `You are currently active in ${total} BotCord sessions. The entries below are latest messages from OTHER rooms, not the current room.`,
    "Do not treat any sender or message below as the current user or current conversation.",
    "Recent activity from other rooms:",
  ];
  for (const e of slice) {
    lines.push(formatEntry(e));
  }
  return lines.join("\n");
}

function formatEntry(e: ActivityEntry): string {
  const ago = formatTimeAgo(e.lastActivityAt);
  const senderLabel = describeSender(e);
  const roomLabel = e.roomName ? `${e.roomName} (${e.roomId})` : e.roomId;
  const topicLabel = e.topic ? ` / topic ${e.topic}` : "";
  const preview = e.lastInboundPreview.trim();
  if (!preview) {
    return `- ${roomLabel}${topicLabel} — last activity ${ago}, no preview`;
  }
  return [
    `- ${roomLabel}${topicLabel} — last ${ago}`,
    `  ${senderLabel}: ${preview}`,
  ].join("\n");
}

function describeSender(e: ActivityEntry): string {
  switch (e.lastSenderKind) {
    case "human":
      return `human ${e.lastSender}`;
    case "owner":
      return `owner`;
    default:
      return `agent ${e.lastSender}`;
  }
}

function formatTimeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}
