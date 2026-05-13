/**
 * Pure attention-gate decision used by the daemon (and, eventually, the
 * plugin) to decide whether an inbound message should wake the LLM. Lives in
 * `@botcord/protocol-core` so the two consumers cannot drift (design §4.2).
 *
 * Inputs are deliberately tiny: a resolved {@link AttentionPolicy} and a
 * minimal {@link AttentionMessage} the caller projects from whatever inbound
 * shape it has. Mention text-fallback is the caller's responsibility — pass
 * the OR of `envelope.mentioned` and any local `@<name>` scan in
 * `message.mentioned`.
 */

/** Attention modes mirroring `hub.enums.AttentionMode`. */
export type AttentionMode =
  | "always"
  | "mention_only"
  | "keyword"
  | "allowed_senders"
  | "muted";

/** Effective per-agent / per-room policy after override resolution. */
export interface AttentionPolicy {
  mode: AttentionMode;
  /** Literal substrings (case-insensitive). Empty → keyword mode never wakes. */
  keywords: string[];
  /** Sender IDs allowed to wake in `allowed_senders` mode. Empty → never wakes. */
  allowedSenderIds?: string[];
  /** Unix milliseconds; when in the future the agent stays muted regardless of mode. */
  muted_until?: number;
}

/** Minimum projection of an inbound message the gate needs to inspect. */
export interface AttentionMessage {
  /** Final mention bit (envelope OR text-scan); true if this agent is addressed. */
  mentioned?: boolean;
  /** Plain text body — used by `keyword` mode. */
  text?: string;
  /** Normalized sender participant ID, e.g. ag_* or hu_*. */
  senderId?: string;
}

/**
 * Decide whether an inbound message should wake the runtime. The function is
 * intentionally side-effect free; logging and metrics are left to the caller
 * so this stays trivially testable.
 *
 * Note: the resolver is responsible for forcing DM rooms (`rm_dm_*`) to
 * `mode: "always"` per design §4.2 — `shouldWake` consumes the policy
 * verbatim and does not second-guess it.
 */
export function shouldWake(
  policy: AttentionPolicy,
  msg: AttentionMessage,
  now: number = Date.now(),
): boolean {
  if (policy.mode === "muted") return false;
  if (typeof policy.muted_until === "number" && policy.muted_until > now) {
    return false;
  }
  switch (policy.mode) {
    case "always":
      return true;
    case "mention_only":
      return msg.mentioned === true;
    case "keyword": {
      // Literal case-insensitive substring match. Regex was rejected for PR3
      // because user-supplied keywords are not vetted — a runaway pattern
      // would burn CPU on every inbound. Promotion to regex is left to a
      // follow-up that adds anchoring + size caps (see design §4.2).
      const text = (msg.text ?? "").toLowerCase();
      if (!text) return false;
      for (const kw of policy.keywords) {
        if (!kw) continue;
        if (text.includes(kw.toLowerCase())) return true;
      }
      return false;
    }
    case "allowed_senders": {
      if (!msg.senderId) return false;
      return (policy.allowedSenderIds ?? []).includes(msg.senderId);
    }
    default:
      // Unknown mode — fail open so a forward-compat policy from a newer Hub
      // doesn't silently mute the agent.
      return true;
  }
}
