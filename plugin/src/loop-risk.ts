type AgentMessageLike = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
};

type UserTurn = {
  text: string;
  normalized: string;
  timestamp?: number;
};

type OutboundSample = {
  text: string;
  normalized: string;
  timestamp: number;
};

export type BotCordLoopRiskReason = {
  id: "high_turn_rate" | "short_ack_tail" | "repeated_outbound";
  summary: string;
};

export type BotCordLoopRiskEvaluation = {
  reasons: BotCordLoopRiskReason[];
};

const outboundBySession = new Map<string, OutboundSample[]>();

const TURN_WINDOW_MS = 2 * 60_000;
const TURN_THRESHOLD = 8;
const ALTERNATION_THRESHOLD = 6;
const MIN_TURNS_PER_SIDE = 3;

const OUTBOUND_MAX_AGE_MS = 10 * 60_000;
const MAX_TRACKED_OUTBOUND = 6;
const SHORT_ACK_MAX_CHARS = 48;
const MIN_REPEAT_TEXT_CHARS = 6;
const OUTBOUND_SIMILARITY_THRESHOLD = 0.88;

const ENGLISH_ACK_OR_CLOSURE = new Set([
  "ok",
  "okay",
  "got it",
  "thanks",
  "thank you",
  "noted",
  "understood",
  "sounds good",
  "sgtm",
  "roger",
  "copy",
  "will do",
  "all good",
  "no worries",
  "bye",
  "goodbye",
  "see you",
  "talk later",
]);

const CHINESE_ACK_OR_CLOSURE = new Set([
  "收到",
  "好的",
  "好",
  "行",
  "嗯",
  "嗯嗯",
  "明白",
  "明白了",
  "知道了",
  "谢谢",
  "谢谢你",
  "感谢",
  "辛苦了",
  "先这样",
  "回头聊",
  "有需要再说",
  "没问题",
  "了解",
  "好嘞",
]);

function resolveTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") return record.text;
        if (typeof record.text === "string") return record.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

function stripBotCordPromptScaffolding(text: string): string {
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
      if (line.includes('reply with exactly "NO_REPLY"')) return false;
      return true;
    });

  return filtered.join("\n").trim();
}

function normalizeLoopText(text: string): string {
  return stripBotCordPromptScaffolding(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isShortAckOrClosure(text: string): boolean {
  const normalized = normalizeLoopText(text);
  if (!normalized || normalized.length > SHORT_ACK_MAX_CHARS) return false;
  return ENGLISH_ACK_OR_CLOSURE.has(normalized) || CHINESE_ACK_OR_CLOSURE.has(normalized);
}

function trigramSet(text: string): Set<string> {
  if (text.length <= 3) return new Set([text]);
  const grams = new Set<string>();
  for (let i = 0; i <= text.length - 3; i++) {
    grams.add(text.slice(i, i + 3));
  }
  return grams;
}

function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aSet = trigramSet(a);
  const bSet = trigramSet(b);
  let intersection = 0;
  for (const gram of aSet) {
    if (bSet.has(gram)) intersection++;
  }
  const union = aSet.size + bSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function areOutboundTextsHighlySimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < MIN_REPEAT_TEXT_CHARS || b.length < MIN_REPEAT_TEXT_CHARS) return false;
  return jaccardSimilarity(a, b) >= OUTBOUND_SIMILARITY_THRESHOLD;
}

function extractHistoricalUserTurns(messages: unknown[]): UserTurn[] {
  const result: UserTurn[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const candidate = message as AgentMessageLike;
    if (candidate.role !== "user") continue;
    const rawText = extractTextFromContent(candidate.content);
    const text = stripBotCordPromptScaffolding(rawText);
    if (!text) continue;
    result.push({
      text,
      normalized: normalizeLoopText(text),
      timestamp: resolveTimestamp(candidate.timestamp),
    });
  }
  return result;
}

function looksLikeBotCordPrompt(prompt: string): boolean {
  return prompt.includes("[BotCord Message]") || prompt.includes("[BotCord Notification]");
}

function pruneOutboundSamples(sessionKey: string, now: number): OutboundSample[] {
  const existing = outboundBySession.get(sessionKey) ?? [];
  const next = existing.filter((sample) => now - sample.timestamp <= OUTBOUND_MAX_AGE_MS);
  if (next.length === 0) {
    outboundBySession.delete(sessionKey);
    return [];
  }
  outboundBySession.set(sessionKey, next);
  return next;
}

function recordOutboundSample(sessionKey: string, sample: OutboundSample): void {
  const existing = pruneOutboundSamples(sessionKey, sample.timestamp);
  const next = [...existing, sample].slice(-MAX_TRACKED_OUTBOUND);
  outboundBySession.set(sessionKey, next);
}

function buildTurnTimeline(params: {
  historicalUserTurns: UserTurn[];
  currentPrompt: string;
  outbound: OutboundSample[];
  now: number;
}): Array<{ role: "user" | "assistant"; timestamp: number }> {
  const { historicalUserTurns, currentPrompt, outbound, now } = params;
  const turns: Array<{ role: "user" | "assistant"; timestamp: number }> = [];

  for (const turn of historicalUserTurns) {
    if (turn.timestamp !== undefined && now - turn.timestamp <= TURN_WINDOW_MS) {
      turns.push({ role: "user", timestamp: turn.timestamp });
    }
  }

  if (stripBotCordPromptScaffolding(currentPrompt)) {
    turns.push({ role: "user", timestamp: now });
  }

  for (const sample of outbound) {
    if (now - sample.timestamp <= TURN_WINDOW_MS) {
      turns.push({ role: "assistant", timestamp: sample.timestamp });
    }
  }

  turns.sort((a, b) => a.timestamp - b.timestamp);
  return turns;
}

function detectHighTurnRate(params: {
  historicalUserTurns: UserTurn[];
  currentPrompt: string;
  outbound: OutboundSample[];
  now: number;
}): BotCordLoopRiskReason | undefined {
  const timeline = buildTurnTimeline(params);
  if (timeline.length < TURN_THRESHOLD) return undefined;

  let userTurns = 0;
  let assistantTurns = 0;
  let alternations = 0;

  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i]?.role === "user") userTurns++;
    if (timeline[i]?.role === "assistant") assistantTurns++;
    if (i > 0 && timeline[i]?.role !== timeline[i - 1]?.role) alternations++;
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

function detectShortAckTail(params: {
  historicalUserTurns: UserTurn[];
  currentPrompt: string;
}): BotCordLoopRiskReason | undefined {
  const currentPrompt = stripBotCordPromptScaffolding(params.currentPrompt);
  const userTexts = params.historicalUserTurns.map((turn) => turn.text);
  if (currentPrompt) userTexts.push(currentPrompt);
  const tail = userTexts.slice(-2);
  if (tail.length < 2) return undefined;
  if (tail.every((text) => isShortAckOrClosure(text))) {
    return {
      id: "short_ack_tail",
      summary: "the last two inbound user messages are short acknowledgements or closure phrases",
    };
  }
  return undefined;
}

function detectRepeatedOutbound(outbound: OutboundSample[]): BotCordLoopRiskReason | undefined {
  const recent = outbound.slice(-3);
  if (recent.length < 2) return undefined;

  const last = recent[recent.length - 1];
  if (!last) return undefined;

  const previous = recent.slice(0, -1);
  const exactMatches = previous.filter((sample) => sample.normalized === last.normalized).length;
  const similarMatches = previous.filter((sample) =>
    areOutboundTextsHighlySimilar(sample.normalized, last.normalized)
  ).length;

  if (exactMatches >= 1 || (recent.length >= 3 && similarMatches >= 2)) {
    return {
      id: "repeated_outbound",
      summary: "recent botcord_send texts in this session are highly similar",
    };
  }

  return undefined;
}

export function shouldRunBotCordLoopRiskCheck(params: {
  channelId?: string;
  prompt: string;
  trigger?: string;
}): boolean {
  if (params.trigger && params.trigger !== "user") return false;
  return params.channelId === "botcord" || looksLikeBotCordPrompt(params.prompt);
}

export function recordBotCordOutboundText(params: {
  sessionKey?: string;
  text?: unknown;
  timestamp?: number;
}): void {
  const sessionKey = params.sessionKey?.trim();
  const rawText = typeof params.text === "string" ? params.text.trim() : "";
  if (!sessionKey || !rawText) return;
  const normalized = normalizeLoopText(rawText);
  if (!normalized) return;
  const timestamp = params.timestamp ?? Date.now();
  recordOutboundSample(sessionKey, { text: rawText, normalized, timestamp });
}

export function clearBotCordLoopRiskSession(sessionKey?: string): void {
  if (!sessionKey) return;
  outboundBySession.delete(sessionKey);
}

export function evaluateBotCordLoopRisk(params: {
  prompt: string;
  messages: unknown[];
  sessionKey?: string;
  now?: number;
}): BotCordLoopRiskEvaluation {
  const now = params.now ?? Date.now();
  const historicalUserTurns = extractHistoricalUserTurns(params.messages);
  const outbound = params.sessionKey ? pruneOutboundSamples(params.sessionKey, now) : [];

  const reasons = [
    detectHighTurnRate({
      historicalUserTurns,
      currentPrompt: params.prompt,
      outbound,
      now,
    }),
    detectShortAckTail({
      historicalUserTurns,
      currentPrompt: params.prompt,
    }),
    detectRepeatedOutbound(outbound),
  ].filter((reason): reason is BotCordLoopRiskReason => Boolean(reason));

  return { reasons };
}

export function buildBotCordLoopRiskPrompt(params: {
  prompt: string;
  messages: unknown[];
  sessionKey?: string;
  now?: number;
}): string | undefined {
  const evaluation = evaluateBotCordLoopRisk(params);
  if (evaluation.reasons.length === 0) return undefined;

  const lines = [
    "[BotCord loop-risk check]",
    "Observed signals:",
    ...evaluation.reasons.map((reason) => `- ${reason.summary}`),
    "",
    "Before sending any BotCord reply, verify that it adds new information, concrete progress, a blocking question, or a final result/error.",
    'If it does not, reply with exactly "NO_REPLY" and nothing else.',
    "Do not send courtesy-only acknowledgements or mirrored sign-offs.",
  ];

  return lines.join("\n");
}

export function didBotCordSendSucceed(result: unknown, error?: string): boolean {
  if (error) return false;
  if (!result || typeof result !== "object") return true;
  const record = result as Record<string, unknown>;
  if (record.ok === true) return true;
  if (typeof record.error === "string" && record.error.trim()) return false;
  return true;
}

export function resetBotCordLoopRiskStateForTests(): void {
  outboundBySession.clear();
}
