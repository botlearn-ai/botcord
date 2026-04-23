/**
 * Daemon-flavored `SystemContextBuilder` factory for the gateway dispatcher.
 *
 * The gateway dispatcher is channel-agnostic; it calls an optional
 * `buildSystemContext` hook and forwards the result to the runtime via
 * `RuntimeRunOptions.systemContext`. This module composes the daemon's
 * system-context string from (a) the agent's working memory and (b) a
 * cross-room activity digest, taking a `GatewayInboundMessage` as input.
 *
 * Behavior:
 *   - Working memory is loaded fresh per turn, so a `memory set` from another
 *     process is visible immediately.
 *   - If `ActivityTracker` is injected, we build the cross-room digest and
 *     EXCLUDE the current room + topic from the list — via
 *     `buildCrossRoomDigest({ currentRoomId, currentTopic })`.
 *   - If both blocks are empty we return `undefined` so the dispatcher
 *     passes `systemContext: undefined` to the runtime (adapter then
 *     skips the injection flag).
 */
import type { GatewayInboundMessage, SystemContextBuilder } from "./gateway/index.js";
import type { ActivityTracker } from "./activity-tracker.js";
import { buildCrossRoomDigest } from "./cross-room.js";
import { buildWorkingMemoryPrompt, readWorkingMemory } from "./working-memory.js";
import { log } from "./log.js";

/** Dependencies injected by the daemon bootstrap. */
export interface SystemContextDeps {
  /** The owning daemon's agent id. Used to scope working-memory + activity lookups. */
  agentId: string;
  /**
   * Activity tracker used to compose the cross-room digest. If omitted the
   * digest block is skipped entirely (working memory still injects).
   */
  activityTracker?: ActivityTracker;
}

function safeReadWorkingMemory(agentId: string) {
  try {
    return readWorkingMemory(agentId);
  } catch (err) {
    log.warn("working memory read failed", { agentId, err: String(err) });
    return null;
  }
}

/**
 * Build a {@link SystemContextBuilder} that mirrors the pre-P0.5 daemon
 * behavior. The returned function is safe to plug directly into
 * `GatewayBootOptions.buildSystemContext`.
 *
 * Narrower sync return type on the factory so callers (and tests) don't have
 * to `await`. `SystemContextBuilder` widens the return to `Promise<...> | ...`
 * so async implementations are allowed — a sync function still satisfies it,
 * we just telegraph the sync-only guarantee at the factory boundary.
 */
export function createDaemonSystemContextBuilder(
  deps: SystemContextDeps,
): (message: GatewayInboundMessage) => string | undefined {
  const builder = (message: GatewayInboundMessage): string | undefined => {
    const blocks: string[] = [];

    const wm = safeReadWorkingMemory(deps.agentId);
    if (wm) {
      // Only emit the memory block when the file exists. An empty file
      // (version:2, sections:{}) still renders a "memory is currently empty"
      // notice — matching the plugin + old dispatcher shape.
      blocks.push(buildWorkingMemoryPrompt({ workingMemory: wm }));
    }

    if (deps.activityTracker) {
      const digest = buildCrossRoomDigest({
        tracker: deps.activityTracker,
        agentId: deps.agentId,
        currentRoomId: message.conversation.id,
        currentTopic: message.conversation.threadId ?? null,
      });
      if (digest) blocks.push(digest);
    }

    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  };

  // Compile-time witness that the narrower sync signature still satisfies
  // `SystemContextBuilder` (which allows async). Prevents the two contracts
  // from silently drifting.
  const _typecheck: SystemContextBuilder = builder;
  void _typecheck;

  return builder;
}
