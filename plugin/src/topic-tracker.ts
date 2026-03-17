/**
 * TopicTracker — Agent-side Topic lifecycle state management.
 *
 * Implements the decision tree from the Topic lifecycle design doc:
 * - No topic → one-way notification, don't auto-reply
 * - Has topic + open → auto-reply OK
 * - Has topic + terminated + has goal → reactivate to open, auto-reply OK
 * - Has topic + terminated + no goal → don't auto-reply
 * - type: result → mark completed
 * - type: error → mark failed
 * - TTL expiration → mark expired
 */

export type TopicState = "open" | "completed" | "failed" | "expired";

export interface TopicInfo {
  state: TopicState;
  goal?: string;
  lastActivityAt: number; // timestamp ms
  ttlMs: number;
}

export interface HandleIncomingParams {
  topic?: string | null;
  goal?: string | null;
  type: string; // message type: "message", "ack", "result", "error", etc.
}

export interface HandleIncomingResult {
  shouldReply: boolean;
  reason: string;
}

export class TopicTracker {
  private topics = new Map<string, TopicInfo>();
  private defaultTtlMs: number;

  constructor(options?: { defaultTtlMs?: number }) {
    this.defaultTtlMs = options?.defaultTtlMs ?? 3_600_000; // 1 hour default
  }

  /**
   * Process an incoming message and return whether the agent should auto-reply.
   *
   * Decision tree:
   *   - No topic → one-way notification, don't auto-reply
   *   - type: "result" → mark completed, don't auto-reply (termination signal)
   *   - type: "error" → mark failed, don't auto-reply (termination signal)
   *   - Topic unseen → create as open, auto-reply
   *   - Topic open → update activity, auto-reply
   *   - Topic terminated (completed/failed/expired):
   *       - Message has goal → reactivate to open, auto-reply
   *       - Message has no goal → don't auto-reply
   */
  handleIncoming(params: HandleIncomingParams): HandleIncomingResult {
    const { topic, goal, type } = params;

    // No topic → one-way notification
    if (!topic) {
      return { shouldReply: false, reason: "no topic — treated as one-way notification" };
    }

    const now = Date.now();
    const existing = this.topics.get(topic);

    // Check if existing topic has expired by TTL
    if (existing && existing.state === "open") {
      if (now - existing.lastActivityAt > existing.ttlMs) {
        existing.state = "expired";
      }
    }

    // Termination signals: result or error
    if (type === "result") {
      this.upsertTopic(topic, "completed", goal ?? existing?.goal, now);
      return { shouldReply: false, reason: "type is result — topic marked completed" };
    }

    if (type === "error") {
      this.upsertTopic(topic, "failed", goal ?? existing?.goal, now);
      return { shouldReply: false, reason: "type is error — topic marked failed" };
    }

    // Topic not seen before → create as open
    if (!existing) {
      this.upsertTopic(topic, "open", goal ?? undefined, now);
      return { shouldReply: true, reason: "new topic created as open" };
    }

    // Topic is open → update activity, auto-reply OK
    if (existing.state === "open") {
      existing.lastActivityAt = now;
      if (goal) existing.goal = goal;
      return { shouldReply: true, reason: "topic is open — auto-reply allowed" };
    }

    // Topic is terminated (completed / failed / expired)
    if (goal) {
      // Reactivate with new goal
      existing.state = "open";
      existing.goal = goal;
      existing.lastActivityAt = now;
      return { shouldReply: true, reason: "terminated topic reactivated with new goal" };
    }

    // Terminated + no goal → don't auto-reply
    return {
      shouldReply: false,
      reason: `topic is ${existing.state} and message has no goal — not auto-replying`,
    };
  }

  /** Get current state of a topic, checking TTL expiration. */
  getState(topicKey: string): TopicState | undefined {
    const info = this.topics.get(topicKey);
    if (!info) return undefined;

    // Check TTL expiration for open topics
    if (info.state === "open" && Date.now() - info.lastActivityAt > info.ttlMs) {
      info.state = "expired";
    }

    return info.state;
  }

  /** Get full topic info. */
  getTopicInfo(topicKey: string): TopicInfo | undefined {
    const info = this.topics.get(topicKey);
    if (!info) return undefined;

    // Check TTL expiration for open topics
    if (info.state === "open" && Date.now() - info.lastActivityAt > info.ttlMs) {
      info.state = "expired";
    }

    return { ...info };
  }

  /** Mark a topic as completed (e.g., when sending a result message). */
  markCompleted(topicKey: string): void {
    const info = this.topics.get(topicKey);
    if (info) {
      info.state = "completed";
      info.lastActivityAt = Date.now();
    }
  }

  /** Mark a topic as failed (e.g., when sending an error message). */
  markFailed(topicKey: string): void {
    const info = this.topics.get(topicKey);
    if (info) {
      info.state = "failed";
      info.lastActivityAt = Date.now();
    }
  }

  /** Clean up expired topics. Returns the count of topics removed. */
  sweepExpired(): number {
    const now = Date.now();
    let count = 0;

    for (const [key, info] of this.topics) {
      // Check TTL expiration for open topics
      if (info.state === "open" && now - info.lastActivityAt > info.ttlMs) {
        info.state = "expired";
      }

      if (info.state === "expired") {
        this.topics.delete(key);
        count++;
      }
    }

    return count;
  }

  /** Return the number of tracked topics. */
  get size(): number {
    return this.topics.size;
  }

  // ── Internal helpers ────────────────────────────────────────────

  private upsertTopic(
    key: string,
    state: TopicState,
    goal: string | undefined,
    now: number,
  ): void {
    const existing = this.topics.get(key);
    if (existing) {
      existing.state = state;
      existing.lastActivityAt = now;
      if (goal !== undefined) existing.goal = goal;
    } else {
      this.topics.set(key, {
        state,
        goal,
        lastActivityAt: now,
        ttlMs: this.defaultTtlMs,
      });
    }
  }
}
