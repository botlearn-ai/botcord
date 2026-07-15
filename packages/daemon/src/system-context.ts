/**
 * Daemon-flavored `SystemContextBuilder` factory for the gateway dispatcher.
 *
 * The gateway dispatcher is channel-agnostic; it calls an optional
 * `buildSystemContext` hook and forwards the result to the runtime via
 * `RuntimeRunOptions.systemContext`. This module composes the daemon's
 * system-context string from:
 *
 *   1. `[BotCord Identity]` (read fresh from workspace/identity.md each turn)
 *   2. `[BotCord Scene: Owner Chat]` (owner-trust turns only)
 *   3. `[BotCord Working Memory]`
 *   4. `[BotCord Room Context]` (group rooms, via optional async fetcher;
 *      room rules are carried separately as `RuntimeRunOptions.systemRules`)
 *   5. `[BotCord Cross-Room Awareness]` (optional activity tracker)
 *   6. `[BotLearn Course Session Profile]` (room-scoped Prompt/Skill overlay)
 *   7. `[BotCord Daemon Skill Index]` (soft skill hot-reload index)
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
import type {
  GatewayInboundMessage,
  SystemContextBuilder,
} from "./gateway/index.js";
import type { ActivityTracker } from "./activity-tracker.js";
import { buildCrossRoomDigest } from "./cross-room.js";
import {
  buildWorkingMemoryPrompt,
  readWorkingMemory,
} from "./working-memory.js";
import { readIdentity } from "./agent-workspace.js";
import { classifyActivitySender } from "./sender-classify.js";
import { log } from "./log.js";
import { buildSoftSkillIndexPrompt } from "./skill-index.js";
import type { SkillIndexOptions } from "./skill-index.js";
import { effectiveMention } from "./mention-scan.js";
import { buildSessionProfilePrompt } from "./session-profile.js";

/**
 * Async per-turn room-context builder (see `room-context.ts`). Returns the
 * rendered `[BotCord Room Context]` block, or `null` when there is nothing
 * to inject (DM, owner-chat, fetch failure, etc.).
 */
export type RoomStaticContextBuilder = (
  message: GatewayInboundMessage
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
    "The owner is reading your reply in the remote BotCord dashboard; they cannot open this machine's local filesystem paths.",
    "When you create an image, report, or other deliverable file for the owner, share it as a BotCord attachment or an uploaded BotCord URL. Do not use local or relative paths such as `output/card.png`, `/tmp/card.png`, or Markdown image links to those paths as if the owner can open them.",
    "If a reply needs to include an image or attachment, upload/attach the file first through the available BotCord file/attachment mechanism, then refer to the uploaded attachment/URL. If upload is unavailable, clearly label any path as a local workspace path rather than a usable deliverable link.",
  ].join("\n");
}

function buildGroupRoomEnvironmentContext(
  message: GatewayInboundMessage
): string | null {
  if (message.conversation.kind !== "group") return null;
  return [
    "[BotCord Runtime Environment]",
    "You are running as a local agent process connected to a remote BotCord group room.",
    "Other room members can read your messages and any uploaded/attached files, but they cannot access this machine's local filesystem, container paths, or absolute paths such as /var/..., /tmp/..., or /Users/....",
    "Do not present a local file path as a useful report link or deliverable in group chat. If an artifact needs to be shared, upload or attach it through the available BotCord file/attachment mechanism, then refer to the uploaded attachment or summarize the content in the message.",
  ].join("\n");
}

function rawSourceType(message: GatewayInboundMessage): string | null {
  const raw = message.raw;
  if (!raw || typeof raw !== "object") return null;
  const sourceType = (raw as { source_type?: unknown }).source_type;
  return typeof sourceType === "string" && sourceType ? sourceType : null;
}

function buildRoomAwarenessContext(message: GatewayInboundMessage): string {
  const sourceType = rawSourceType(message);
  const sender = classifyActivitySender(message);
  const roomType =
    sender.kind === "owner"
      ? "owner_dm"
      : sourceType === "botcord_schedule"
      ? "scheduler"
      : message.conversation.kind === "group"
      ? "team_room"
      : message.conversation.id.startsWith("rm_dm_")
      ? "user_dm"
      : "cross_room_or_external";

  const lines = [
    "[BotCord Room-Type Awareness]",
    `room_type: ${roomType}`,
    `conversation_kind: ${message.conversation.kind}`,
    `mentioned: ${effectiveMention(message) ? "true" : "false"}`,
    "Treat mentions as routing context, not as a mandatory public reply requirement. A mention can be an FYI, attribution, or action request; decide which from the message content, room policy, and working memory.",
    "Public replies in shared rooms are appropriate only for new facts, blockers, approval requests, execution results, review findings, or explicit action requests. Pure acknowledgements, thanks, receipt confirmations, or duplicate status should use working memory/tool side effects or exactly NO_REPLY.",
    "NO_REPLY is a normal first-class outcome in team rooms when no public response is needed.",
    "Cross-room awareness and room digests are context only. Do not answer another room from the current room unless a pending task or explicit owner-approved workflow requires that handoff.",
  ];

  if (roomType === "team_room") {
    lines.push(
      "Shared-room spokesperson convention: prefer a single public summary from the person or agent responsible for the relevant area. Others should avoid duplicate confirmations, boundary restatements, or courtesy acknowledgements.",
      "If another responsible spokesperson has already handled the point, stay silent or update memory instead of adding a courtesy acknowledgement."
    );
  } else if (roomType === "scheduler") {
    lines.push(
      "Scheduler turns are proactive work triggers. Execute the scheduled task, then reply publicly only if the schedule expects a report, needs approval, hits a blocker, or produces a useful result."
    );
  } else if (roomType === "owner_dm") {
    lines.push(
      "Owner-DM turns are private and trusted; answer normally unless the conversation has naturally concluded."
    );
  } else if (roomType === "user_dm") {
    lines.push(
      "User-DM turns are direct conversations; answer normally when useful, and use NO_REPLY only when no response is needed."
    );
  }

  return lines.join("\n");
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
   * members). Omitting keeps the builder synchronous and the block
   * is skipped.
   */
  roomContextBuilder?: RoomStaticContextBuilder;
  /**
   * Optional per-turn loop-risk check. Returns a warning block when the
   * session shows signs of agent-to-agent echo or courtesy loops. Sync
   * + cheap — consulted every turn even when roomContextBuilder is absent.
   */
  loopRiskBuilder?: (message: GatewayInboundMessage) => string | null;
  /**
   * Optional soft skill index builder. Defaults to scanning daemon-known skill
   * dirs each turn. Return null to suppress the block.
   */
  skillIndexBuilder?: (message: GatewayInboundMessage) => string | null;
  /**
   * Runtime/profile options for the default soft skill scanner. Kept lazy so
   * hot-provisioned runtime changes are visible without rebuilding this closure.
   */
  skillIndexOptions?: (message: GatewayInboundMessage) => SkillIndexOptions;
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
 * Read identity.md and wrap it as a system-context block. Placed before
 * every other block so the agent answers "who are you" from this file
 * rather than from the underlying CLI's default persona ("I am Claude
 * Code"). Re-read every turn so dashboard reconcile (`applyAgentIdentity`)
 * and self-edits take effect immediately, mirroring working-memory
 * semantics.
 */
function buildIdentityPrompt(agentId: string): string | null {
  let raw: string | null = null;
  try {
    raw = readIdentity(agentId);
  } catch (err) {
    log.warn("identity read failed", { agentId, err: String(err) });
    return null;
  }
  if (!raw) return null;
  return [
    "[BotCord Identity]",
    "Your persistent identity card. The fields below are the source of truth — when asked who you are, what you do, or what you will / will not do, answer from this block, not from the underlying CLI's default persona.",
    "",
    raw.trim(),
  ].join("\n");
}

/**
 * Build a {@link SystemContextBuilder} for the gateway dispatcher.
 *
 * When `deps.roomContextBuilder` is provided the returned function is async
 * so it can await the Hub fetch; otherwise it stays synchronous (same shape
 * as the pre-P1 daemon builder). Both shapes satisfy `SystemContextBuilder`.
 */
export function createDaemonSystemContextBuilder(
  deps: SystemContextDeps
): (
  message: GatewayInboundMessage
) => Promise<string | undefined> | string | undefined {
  const gatherSyncBlocks = (
    message: GatewayInboundMessage
  ): {
    identity: string | null;
    ownerScene: string | null;
    roomAwareness: string | null;
    environment: string | null;
    memory: string | null;
    digest: string | null;
  } => {
    const identity = buildIdentityPrompt(deps.agentId);

    const ownerScene =
      classifyActivitySender(message).kind === "owner"
        ? buildOwnerChatSceneContext()
        : null;
    const roomAwareness = buildRoomAwarenessContext(message);
    const environment = ownerScene
      ? null
      : buildGroupRoomEnvironmentContext(message);

    const wm = safeReadWorkingMemory(deps.agentId);
    const memory = buildWorkingMemoryPrompt({ workingMemory: wm });

    const digest = deps.activityTracker
      ? buildCrossRoomDigest({
          tracker: deps.activityTracker,
          agentId: deps.agentId,
          currentRoomId: message.conversation.id,
          currentTopic: message.conversation.threadId ?? null,
        }) || null
      : null;

    return { identity, ownerScene, roomAwareness, environment, memory, digest };
  };

  const assemble = (
    parts: Array<string | null | undefined>
  ): string | undefined => {
    const filtered = parts.filter(
      (p): p is string => typeof p === "string" && p.length > 0
    );
    return filtered.length > 0 ? filtered.join("\n\n") : undefined;
  };

  const runLoopRisk = (message: GatewayInboundMessage): string | null => {
    if (!deps.loopRiskBuilder) return null;
    try {
      return deps.loopRiskBuilder(message);
    } catch (err) {
      log.warn(
        "system-context: loopRiskBuilder threw — skipping loop-risk block",
        {
          agentId: deps.agentId,
          roomId: message.conversation.id,
          err: err instanceof Error ? err.message : String(err),
        }
      );
      return null;
    }
  };

  const buildSkillIndex = (message: GatewayInboundMessage): string | null => {
    try {
      if (deps.skillIndexBuilder) return deps.skillIndexBuilder(message);
      return buildSoftSkillIndexPrompt(
        deps.agentId,
        deps.skillIndexOptions?.(message) ?? {}
      );
    } catch (err) {
      log.warn(
        "system-context: skill index build failed — skipping skill block",
        {
          agentId: deps.agentId,
          roomId: message.conversation.id,
          err: err instanceof Error ? err.message : String(err),
        }
      );
      return null;
    }
  };

  const buildSessionProfile = (message: GatewayInboundMessage): string | null => {
    try {
      return buildSessionProfilePrompt(deps.agentId, message.conversation.id);
    } catch (err) {
      log.warn(
        "system-context: session profile build failed — skipping session block",
        {
          agentId: deps.agentId,
          roomId: message.conversation.id,
          err: err instanceof Error ? err.message : String(err),
        }
      );
      return null;
    }
  };

  if (!deps.roomContextBuilder) {
    const syncBuilder = (
      message: GatewayInboundMessage
    ): string | undefined => {
      const {
        identity,
        ownerScene,
        roomAwareness,
        environment,
        memory,
        digest,
      } = gatherSyncBlocks(message);
      // Loop-risk sits at the end so its "reply NO_REPLY unless…" guidance
      // is the last thing the model sees before the user turn body.
      // Identity sits at the very front so it frames every other block.
      const sessionProfile = buildSessionProfile(message);
      const skillIndex = buildSkillIndex(message);
      const loopRisk = runLoopRisk(message);
      return assemble([
        identity,
        ownerScene,
        roomAwareness,
        environment,
        memory,
        digest,
        sessionProfile,
        skillIndex,
        loopRisk,
      ]);
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
    message: GatewayInboundMessage
  ): Promise<string | undefined> => {
    const { identity, ownerScene, roomAwareness, environment, memory, digest } =
      gatherSyncBlocks(message);
    // Room context landing order: after owner-scene / memory, before digest —
    // "what room am I in" belongs with the session's own identity, while the
    // cross-room digest deliberately describes OTHER rooms and should stay
    // last so it doesn't get confused with the current room.
    // Identity stays at the very front; see syncBuilder for rationale.
    let roomBlock: string | null = null;
    try {
      roomBlock = await roomBuilder(message);
    } catch (err) {
      log.warn(
        "system-context: roomContextBuilder threw — skipping room block",
        {
          agentId: deps.agentId,
          roomId: message.conversation.id,
          err: err instanceof Error ? err.message : String(err),
        }
      );
    }
    const sessionProfile = buildSessionProfile(message);
    const skillIndex = buildSkillIndex(message);
    const loopRisk = runLoopRisk(message);
    return assemble([
      identity,
      ownerScene,
      roomAwareness,
      environment,
      memory,
      roomBlock,
      digest,
      sessionProfile,
      skillIndex,
      loopRisk,
    ]);
  };
  const _typecheck: SystemContextBuilder = asyncBuilder;
  void _typecheck;
  return asyncBuilder;
}
