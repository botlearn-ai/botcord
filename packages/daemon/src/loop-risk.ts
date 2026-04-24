/**
 * Loop-risk guard — detects patterns that suggest two daemon-hosted agents
 * are stuck echoing each other (or that a conversation has naturally
 * wound down but both sides keep sending courtesy acks). When triggered,
 * `buildLoopRiskPrompt()` returns an injected hint that encourages the
 * agent to reply with `NO_REPLY` unless it has something substantive to
 * add.
 *
 * Ported from `plugin/src/loop-risk.ts` with one structural change: plugin
 * has OpenClaw's message transcript available (`messages: unknown[]`) so
 * it can reconstruct historical user turns on demand. Daemon does not —
 * Claude Code owns the transcript, not daemon. So daemon records inbound
 * texts in a module-level map the same way plugin records outbound ones.
 *
 * Detectors:
 *   - high_turn_rate  — many user↔assistant alternations in a short window
 *   - short_ack_tail  — the last two inbound texts are acks / closure phrases
 *   - repeated_outbound — recent outbound replies are highly similar
 */

interface Sample {
  text: string;
  normalized: string;
  timestamp: number;
}

export type LoopRiskReason = {
  id: "high_turn_rate" | "short_ack_tail" | "repeated_outbound";
  summary: string;
};

export interface LoopRiskEvaluation {
  reasons: LoopRiskReason[];
}

// Module-level state. Keys are caller-supplied session identifiers
// (daemon uses `${accountId}:${conversationId}:${threadId ?? ""}`).
const inboundBySession = new Map<string, Sample[]>();
const outboundBySession = new Map<string, Sample[]>();

// --- Tunables ---------------------------------------------------------

const TURN_WINDOW_MS = 2 * 60_000;
const TURN_THRESHOLD = 8;
const ALTERNATION_THRESHOLD = 6;
const MIN_TURNS_PER_SIDE = 3;

const SAMPLE_MAX_AGE_MS = 10 * 60_000;
const MAX_TRACKED_PER_SIDE = 6;

const SHORT_ACK_MAX_CHARS = 48;
const MIN_REPEAT_TEXT_CHARS = 6;
const OUTBOUND_SIMILARITY_THRESHOLD = 0.88;

// --- Ack / closure phrase lists (mirrors plugin) ----------------------

const ENGLISH_ACK_OR_CLOSURE = new Set([
  "ok", "okay", "got it", "thanks", "thank you", "noted", "understood",
  "sounds good", "sgtm", "roger", "copy", "will do", "all good",
  "no worries", "bye", "goodbye", "see you", "talk later",
]);

const CHINESE_ACK_OR_CLOSURE = new Set([
  "收到", "好的", "好", "行", "嗯", "嗯嗯", "明白", "明白了", "知道了",
  "谢谢", "谢谢你", "感谢", "辛苦了", "先这样", "回头聊", "有需要再说",
  "没问题", "了解", "好嘞",
]);

// --- Text normalization -----------------------------------------------

/**
 * Strip the `[BotCord Message] | …` header and `<agent-message>` / hint
 * wrappers the user-turn composer adds around the raw inbound text. Leaves
 * the plain body so similarity / ack detection operates on actual content.
 * Kept in sync with `turn-text.ts` output shape.
 */
export function stripBotCordPromptScaffolding(text: string): string {
  const filtered = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith("[BotCord Message]")) return false;
      if (line.startsWith("[BotCord Notification]")) return false;
      if (line.startsWith("[Room Rule]")) return false;
      if (line.startsWith("[In group chats, do NOT reply")) return false;
      if (line.startsWith("[If the conversation has naturally concluded")) return false;
      if (line.startsWith("[You received a contact request")) return false;
      if (line.includes('reply with exactly "NO_REPLY"')) return false;
      if (line.startsWith("<agent-message")) return false;
      if (line === "</agent-message>") return false;
      if (line.startsWith("<human-message")) return false;
      if (line === "</human-message>") return false;
      return true;
    });
  return filtered.join("\n").trim();
}

export function normalizeLoopText(text: string): string {
  return stripBotCordPromptScaffolding(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isShortAckOrClosure(text: string): boolean {
  const n = normalizeLoopText(text);
  if (!n || n.length > SHORT_ACK_MAX_CHARS) return false;
  return ENGLISH_ACK_OR_CLOSURE.has(n) || CHINESE_ACK_OR_CLOSURE.has(n);
}

// --- Similarity -------------------------------------------------------

function trigramSet(text: string): Set<string> {
  if (text.length <= 3) return new Set([text]);
  const grams = new Set<string>();
  for (let i = 0; i <= text.length - 3; i++) grams.add(text.slice(i, i + 3));
  return grams;
}

function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigramSet(a);
  const B = trigramSet(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function areOutboundTextsHighlySimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < MIN_REPEAT_TEXT_CHARS || b.length < MIN_REPEAT_TEXT_CHARS) return false;
  return jaccardSimilarity(a, b) >= OUTBOUND_SIMILARITY_THRESHOLD;
}

// --- Sample store -----------------------------------------------------

function prune(map: Map<string, Sample[]>, sessionKey: string, now: number): Sample[] {
  const existing = map.get(sessionKey) ?? [];
  const next = existing.filter((s) => now - s.timestamp <= SAMPLE_MAX_AGE_MS);
  if (next.length === 0) {
    map.delete(sessionKey);
    return [];
  }
  map.set(sessionKey, next);
  return next;
}

function record(
  map: Map<string, Sample[]>,
  sessionKey: string,
  sample: Sample,
): void {
  const kept = prune(map, sessionKey, sample.timestamp);
  const next = [...kept, sample].slice(-MAX_TRACKED_PER_SIDE);
  map.set(sessionKey, next);
}

export function recordInboundText(params: {
  sessionKey?: string;
  text?: unknown;
  timestamp?: number;
}): void {
  const sessionKey = params.sessionKey?.trim();
  const raw = typeof params.text === "string" ? params.text.trim() : "";
  if (!sessionKey || !raw) return;
  const normalized = normalizeLoopText(raw);
  if (!normalized) return;
  record(inboundBySession, sessionKey, {
    text: raw,
    normalized,
    timestamp: params.timestamp ?? Date.now(),
  });
}

export function recordOutboundText(params: {
  sessionKey?: string;
  text?: unknown;
  timestamp?: number;
}): void {
  const sessionKey = params.sessionKey?.trim();
  const raw = typeof params.text === "string" ? params.text.trim() : "";
  if (!sessionKey || !raw) return;
  const normalized = normalizeLoopText(raw);
  if (!normalized) return;
  record(outboundBySession, sessionKey, {
    text: raw,
    normalized,
    timestamp: params.timestamp ?? Date.now(),
  });
}

export function clearLoopRiskSession(sessionKey?: string): void {
  if (!sessionKey) return;
  inboundBySession.delete(sessionKey);
  outboundBySession.delete(sessionKey);
}

export function resetLoopRiskStateForTests(): void {
  inboundBySession.clear();
  outboundBySession.clear();
}

// --- Detectors --------------------------------------------------------

function detectHighTurnRate(inbound: Sample[], outbound: Sample[], now: number):
  LoopRiskReason | undefined {
  const timeline: Array<{ role: "user" | "assistant"; timestamp: number }> = [];
  for (const s of inbound) {
    if (now - s.timestamp <= TURN_WINDOW_MS) timeline.push({ role: "user", timestamp: s.timestamp });
  }
  for (const s of outbound) {
    if (now - s.timestamp <= TURN_WINDOW_MS) timeline.push({ role: "assistant", timestamp: s.timestamp });
  }
  if (timeline.length < TURN_THRESHOLD) return undefined;
  timeline.sort((a, b) => a.timestamp - b.timestamp);

  let userTurns = 0;
  let assistantTurns = 0;
  let alternations = 0;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i]!.role === "user") userTurns++;
    else assistantTurns++;
    if (i > 0 && timeline[i]!.role !== timeline[i - 1]!.role) alternations++;
  }

  if (
    userTurns >= MIN_TURNS_PER_SIDE &&
    assistantTurns >= MIN_TURNS_PER_SIDE &&
    alternations >= ALTERNATION_THRESHOLD
  ) {
    return {
      id: "high_turn_rate",
      summary: `same session shows ${timeline.length} user/assistant turns within ${Math.round(TURN_WINDOW_MS / 1000)}s`,
    };
  }
  return undefined;
}

function detectShortAckTail(inbound: Sample[]): LoopRiskReason | undefined {
  const tail = inbound.slice(-2);
  if (tail.length < 2) return undefined;
  if (tail.every((s) => isShortAckOrClosure(s.text))) {
    return {
      id: "short_ack_tail",
      summary: "the last two inbound user messages are short acknowledgements or closure phrases",
    };
  }
  return undefined;
}

function detectRepeatedOutbound(outbound: Sample[]): LoopRiskReason | undefined {
  const recent = outbound.slice(-3);
  if (recent.length < 2) return undefined;
  const last = recent[recent.length - 1];
  if (!last) return undefined;
  const previous = recent.slice(0, -1);
  const exact = previous.filter((s) => s.normalized === last.normalized).length;
  const similar = previous.filter((s) =>
    areOutboundTextsHighlySimilar(s.normalized, last.normalized),
  ).length;
  if (exact >= 1 || (recent.length >= 3 && similar >= 2)) {
    return {
      id: "repeated_outbound",
      summary: "recent outbound texts in this session are highly similar",
    };
  }
  return undefined;
}

export function evaluateLoopRisk(params: {
  sessionKey?: string;
  now?: number;
}): LoopRiskEvaluation {
  const now = params.now ?? Date.now();
  if (!params.sessionKey) return { reasons: [] };
  const inbound = prune(inboundBySession, params.sessionKey, now);
  const outbound = prune(outboundBySession, params.sessionKey, now);
  const reasons = [
    detectHighTurnRate(inbound, outbound, now),
    detectShortAckTail(inbound),
    detectRepeatedOutbound(outbound),
  ].filter((r): r is LoopRiskReason => Boolean(r));
  return { reasons };
}

/** Build the injected system-context hint, or `null` if no risk detected. */
export function buildLoopRiskPrompt(params: {
  sessionKey?: string;
  now?: number;
}): string | null {
  const evaluation = evaluateLoopRisk(params);
  if (evaluation.reasons.length === 0) return null;
  return [
    "[BotCord loop-risk check]",
    "Observed signals:",
    ...evaluation.reasons.map((r) => `- ${r.summary}`),
    "",
    "Before sending any BotCord reply, verify that it adds new information, concrete progress, a blocking question, or a final result/error.",
    'If it does not, reply with exactly "NO_REPLY" and nothing else.',
    "Do not send courtesy-only acknowledgements or mirrored sign-offs.",
  ].join("\n");
}

/**
 * Derive a loop-risk session key from a gateway inbound message or
 * outbound reply. Keyed on (accountId, conversationId, threadId) so a
 * DM and a group thread under the same agent don't share state.
 */
export function loopRiskSessionKey(params: {
  accountId: string;
  conversationId: string;
  threadId?: string | null;
}): string {
  const thread = params.threadId ?? "";
  return `${params.accountId}:${params.conversationId}:${thread}`;
}
