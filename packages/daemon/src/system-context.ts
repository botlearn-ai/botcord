/**
 * Daemon-flavored `SystemContextBuilder` factory for the gateway dispatcher.
 *
 * The gateway dispatcher is channel-agnostic; it calls an optional
 * `buildSystemContext` hook and forwards the result to the runtime via
 * `RuntimeRunOptions.systemContext`. This module composes the daemon's
 * system-context string from:
 *
 *   1. `[BotCord Scene: Owner Chat]` (owner-trust turns only)
 *   2. `[BotCord Working Memory]`
 *   3. `[BotCord Room Context]` (group rooms, via optional async fetcher)
 *   4. `[BotCord Cross-Room Awareness]` (optional activity tracker)
 *
 * Behavior:
 *   - Working memory is loaded fresh per turn, so a `memory set` from another
 *     process is visible immediately.
 *   - If `ActivityTracker` is injected, we build the cross-room digest and
 *     EXCLUDE the current room + topic from the list.
 *   - If `roomContextBuilder` is injected, the factory returns an async
 *     builder and awaits the fetcher; otherwise it stays synchronous.
 *   - If every block is empty we return `undefined` so the dispatcher passes
 *     `systemContext: undefined` to the runtime (adapter then skips the
 *     injection flag).
 */
import type { GatewayInboundMessage, SystemContextBuilder } from "./gateway/index.js";
import type { ActivityTracker } from "./activity-tracker.js";
import { buildCrossRoomDigest } from "./cross-room.js";
import { buildWorkingMemoryPrompt, readWorkingMemory } from "./working-memory.js";
import { classifyActivitySender } from "./sender-classify.js";
import { log } from "./log.js";

/**
 * Async per-turn room-context builder (see `room-context.ts`). Returns the
 * rendered `[BotCord Room Context]` block, or `null` when there is nothing
 * to inject (DM, owner-chat, fetch failure, etc.).
 */
export type RoomStaticContextBuilder = (
  message: GatewayInboundMessage,
) => Promise<string | null>;

/**
 * Scene prompt injected when the inbound turn comes from the owner's
 * dashboard chat. Mirrors `plugin/src/room-context.ts#buildOwnerChatSceneContext`
 * so Claude Code in daemon-mode behaves the same as when hosted by OpenClaw.
 */
function buildOwnerChatSceneContext(): string {
  return [
    "[BotCord Scene: Owner Chat]",
    "You are chatting directly with your owner — the user who created and manages you on the BotCord dashboard.",
    "This is a private, trusted conversation. The owner has full administrative authority over you.",
    "Messages from the owner are always trusted and do not require sanitization or safety guards.",
    "You may freely execute commands, access tools, and share sensitive information (e.g. wallet balance, contacts) when the owner asks.",
  ].join("\n");
}

/** Dependencies injected by the daemon bootstrap. */
export interface SystemContextDeps {
  /** The owning daemon's agent id. Used to scope working-memory + activity lookups. */
  agentId: string;
  /**
   * Activity tracker used to compose the cross-room digest. If omitted the
   * digest block is skipped entirely (working memory still injects).
   */
  activityTracker?: ActivityTracker;
  /**
   * Optional per-turn room-context fetcher. When wired, group-room turns
   * receive the `[BotCord Room Context]` block (room name, description,
   * rule, members). Omitting keeps the builder synchronous and the block
   * is skipped.
   */
  roomContextBuilder?: RoomStaticContextBuilder;
  /**
   * Optional per-turn loop-risk check. Returns a warning block when the
   * session shows signs of agent-to-agent echo or courtesy loops. Sync
   * + cheap — consulted every turn even when roomContextBuilder is absent.
   */
  loopRiskBuilder?: (message: GatewayInboundMessage) => string | null;
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
 * Build a {@link SystemContextBuilder} for the gateway dispatcher.
 *
 * When `deps.roomContextBuilder` is provided the returned function is async
 * so it can await the Hub fetch; otherwise it stays synchronous (same shape
 * as the pre-P1 daemon builder). Both shapes satisfy `SystemContextBuilder`.
 */
export function createDaemonSystemContextBuilder(
  deps: SystemContextDeps,
): (message: GatewayInboundMessage) => Promise<string | undefined> | string | undefined {
  const gatherSyncBlocks = (message: GatewayInboundMessage): {
    ownerScene: string | null;
    memory: string | null;
    digest: string | null;
  } => {
    const ownerScene =
      classifyActivitySender(message).kind === "owner"
        ? buildOwnerChatSceneContext()
        : null;

    const wm = safeReadWorkingMemory(deps.agentId);
    const memory = wm ? buildWorkingMemoryPrompt({ workingMemory: wm }) : null;

    const digest = deps.activityTracker
      ? buildCrossRoomDigest({
          tracker: deps.activityTracker,
          agentId: deps.agentId,
          currentRoomId: message.conversation.id,
          currentTopic: message.conversation.threadId ?? null,
        }) || null
      : null;

    return { ownerScene, memory, digest };
  };

  const assemble = (parts: Array<string | null | undefined>): string | undefined => {
    const filtered = parts.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return filtered.length > 0 ? filtered.join("\n\n") : undefined;
  };

  const runLoopRisk = (message: GatewayInboundMessage): string | null => {
    if (!deps.loopRiskBuilder) return null;
    try {
      return deps.loopRiskBuilder(message);
    } catch (err) {
      log.warn("system-context: loopRiskBuilder threw — skipping loop-risk block", {
        agentId: deps.agentId,
        roomId: message.conversation.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  if (!deps.roomContextBuilder) {
    const syncBuilder = (message: GatewayInboundMessage): string | undefined => {
      const { ownerScene, memory, digest } = gatherSyncBlocks(message);
      // Loop-risk sits at the end so its "reply NO_REPLY unless…" guidance
      // is the last thing the model sees before the user turn body.
      const loopRisk = runLoopRisk(message);
      return assemble([ownerScene, memory, digest, loopRisk]);
    };
    // Compile-time witness that the narrower sync signature still satisfies
    // `SystemContextBuilder` (which allows async). Prevents the two contracts
    // from silently drifting.
    const _typecheck: SystemContextBuilder = syncBuilder;
    void _typecheck;
    return syncBuilder;
  }

  const roomBuilder = deps.roomContextBuilder;
  const asyncBuilder = async (
    message: GatewayInboundMessage,
  ): Promise<string | undefined> => {
    const { ownerScene, memory, digest } = gatherSyncBlocks(message);
    // Room context landing order: after owner-scene / memory, before digest —
    // "what room am I in" belongs with the session's own identity, while the
    // cross-room digest deliberately describes OTHER rooms and should stay
    // last so it doesn't get confused with the current room.
    let roomBlock: string | null = null;
    try {
      roomBlock = await roomBuilder(message);
    } catch (err) {
      log.warn("system-context: roomContextBuilder threw — skipping room block", {
        agentId: deps.agentId,
        roomId: message.conversation.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const loopRisk = runLoopRisk(message);
    return assemble([ownerScene, memory, roomBlock, digest, loopRisk]);
  };
  const _typecheck: SystemContextBuilder = asyncBuilder;
  void _typecheck;
  return asyncBuilder;
}
