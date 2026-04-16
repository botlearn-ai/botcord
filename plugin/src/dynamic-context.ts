/**
 * BotCord dynamic context builder.
 *
 * Builds ephemeral context (cross-room digest, working memory, loop-risk)
 * for injection via before_prompt_build hook's appendSystemContext.
 *
 * Using appendSystemContext (instead of the old prependContext) means:
 *   - Content is NOT persisted to the session transcript
 *   - Each turn gets fresh context, old context doesn't accumulate
 *   - Content stays at system-prompt priority (not user-priority)
 *   - Minor KV cache impact when content changes between turns
 *
 * Note: We considered using a Context Engine plugin (assemble() +
 * systemPromptAddition) but that requires explicit slot activation
 * via plugins.slots.contextEngine config. The hook approach works
 * out of the box with zero config.
 */
import { buildCrossRoomDigest, getSessionRoom } from "./room-context.js";
import { readWorkingMemory, readOrSeedWorkingMemory } from "./memory.js";
import { buildWorkingMemoryPrompt } from "./memory-protocol.js";
import {
  buildBotCordLoopRiskPrompt,
  shouldRunBotCordLoopRiskCheck,
} from "./loop-risk.js";
import type { BotCordClient as BotCordClientType } from "./client.js";

/**
 * Build the dynamic context for a BotCord session.
 * Returns appendSystemContext string, or null if no context needed.
 *
 * Called from the before_prompt_build hook in index.ts.
 */
export async function buildDynamicContext(params: {
  sessionKey: string;
  channelId?: string;
  prompt?: string;
  messages?: unknown[];
  trigger?: string;
  client?: BotCordClientType;
  credentialsFile?: string;
}): Promise<string | null> {
  const { sessionKey, channelId, prompt, messages, trigger, client, credentialsFile } = params;

  const isOwnerChat = sessionKey === "botcord:owner:main";
  const isBotCordSession = isOwnerChat || !!getSessionRoom(sessionKey);

  // Read working memory early — needed both for injection and for the
  // onboarding gate decision below.
  let wm: Awaited<ReturnType<typeof readOrSeedWorkingMemory>> = null;
  try {
    wm = client
      ? await readOrSeedWorkingMemory({ client, credentialsFile })
      : readWorkingMemory();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[botcord] dynamic-context: failed to read working memory:", msg);
  }

  const onboardingPending = !!wm?.sections?.onboarding;

  // Gate: inject context for BotCord sessions unconditionally, but also
  // for ANY session while onboarding is still pending — so the agent can
  // start/continue onboarding from Telegram, Discord, webchat, etc.
  if (!isBotCordSession && !onboardingPending) return null;

  const parts: string[] = [];

  // 1. Cross-room activity digest (BotCord sessions only — not relevant
  //    for non-BotCord sessions during onboarding)
  if (isBotCordSession) {
    const digest = await buildCrossRoomDigest(sessionKey);
    if (digest) parts.push(digest);
  }

  // 2. Working memory
  const memoryPrompt = buildWorkingMemoryPrompt({ workingMemory: wm });
  parts.push(memoryPrompt);

  // 3. Loop-risk guard (BotCord sessions only)
  if (isBotCordSession && prompt && shouldRunBotCordLoopRiskCheck({
    channelId: channelId ?? "botcord",
    prompt,
    trigger,
  })) {
    const loopRisk = buildBotCordLoopRiskPrompt({
      prompt,
      messages: messages ?? [],
      sessionKey,
    });
    if (loopRisk) parts.push(loopRisk);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
