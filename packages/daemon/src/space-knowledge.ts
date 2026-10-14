/**
 * Space knowledge-base context — injects the acting Space's README and
 * top-level index (`[BotCord Space Knowledge]`) for organization-room turns,
 * so the agent knows the knowledge base exists and where to look before it
 * answers. Full retrieval stays agentic via `botcord kb tree|grep|search|cat`.
 * See docs/space-knowledge-base-design.md.
 *
 * Scope:
 *   - Only turns whose inbox entry carries `space_context.space_id`
 *     (organization rooms). Personal rooms/DMs skip the block.
 *   - Empty knowledge bases (no README, no pages) inject nothing.
 *   - Cached per `accountId:spaceId` with a short TTL; fetch failures are not
 *     cached and never block the turn.
 *   - The rendered block is capped at {@link MAX_BLOCK_CHARS}.
 */
import type { KbContext } from "@botcord/protocol-core";
import { sanitizeUntrustedContent } from "./gateway/index.js";
import type { GatewayInboundMessage } from "./gateway/index.js";
import type { AgentClientResolver } from "./room-context-fetcher.js";

export const MAX_BLOCK_CHARS = 4000;
const DEFAULT_TTL_MS = 2 * 60 * 1000;

export type SpaceKnowledgeFetcher = (params: {
  accountId: string;
  spaceId: string;
}) => Promise<KbContext | null>;

interface CtxLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface SpaceKnowledgeBuilderOptions {
  fetchContext: SpaceKnowledgeFetcher;
  ttlMs?: number;
  now?: () => number;
  log?: CtxLogger;
}

/** The Space of this turn, from the inbox entry's `space_context`. */
export function spaceIdOf(message: GatewayInboundMessage): string | null {
  const raw = message.raw as
    | { batch?: unknown[]; space_context?: { space_id?: unknown } | null }
    | undefined;
  const entries = Array.isArray(raw?.batch) ? raw.batch : [raw];
  for (const entry of entries) {
    const id = (entry as typeof raw)?.space_context?.space_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function oneLine(text: string): string {
  return sanitizeUntrustedContent(text.replace(/\s+/g, " ").trim());
}

/** Render the block, or `null` when the knowledge base is empty. Exported for tests. */
export function renderSpaceKnowledgeBlock(ctx: KbContext): string | null {
  if (!ctx.readme && ctx.index.length === 0) return null;
  const name = ctx.space_name ? oneLine(ctx.space_name) : ctx.space_id;
  const head = [
    `[BotCord Space Knowledge: ${name}]`,
    `This Space keeps a shared knowledge base (${ctx.page_count} pages) — the source of truth for its conventions, processes, decisions and past results.`,
    `Before answering how this team works or repeating past work, look it up and cite page paths: botcord kb tree|grep|search|cat --space ${ctx.space_id}.`,
    "Record durable learnings with `botcord kb write` (reviewed as drafts; pages under /archive/ publish directly).",
  ].join("\n");

  const index = ctx.index.map((item) => {
    const label = item.kind === "dir" ? `${item.path}/ (${item.children ?? 0})` : item.path;
    const desc = item.description ?? item.title;
    return desc ? `- ${label} — ${oneLine(desc)}` : `- ${label}`;
  });
  if (ctx.index_truncated) index.push("- … (more: botcord kb tree /)");

  const indexText = index.length > 0 ? `\n\nIndex:\n${index.join("\n")}` : "";
  const budget = MAX_BLOCK_CHARS - head.length - indexText.length;
  let readmeText = "";
  if (ctx.readme && budget > 200) {
    const body = sanitizeUntrustedContent(ctx.readme.trim());
    const clipped = body.length > budget - 60 || ctx.readme_truncated;
    readmeText = `\n\nREADME (/README.md):\n${body.slice(0, budget - 60)}${clipped ? "\n… (truncated: botcord kb cat /README.md)" : ""}`;
  }
  const block = `${head}${readmeText}${indexText}`;
  return block.length > MAX_BLOCK_CHARS ? `${block.slice(0, MAX_BLOCK_CHARS - 1)}…` : block;
}

export function createSpaceKnowledgeFetcher(getClient: AgentClientResolver): SpaceKnowledgeFetcher {
  return async ({ accountId, spaceId }) => {
    const client = getClient(accountId);
    if (!client) return null;
    return await client.kbContext(spaceId);
  };
}

export function createSpaceKnowledgeContextBuilder(
  opts: SpaceKnowledgeBuilderOptions,
): (message: GatewayInboundMessage) => Promise<string | null> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { blockText: string | null; fetchedAt: number }>();
  const inflight = new Map<string, Promise<string | null>>();

  return async function getBlock(message) {
    const spaceId = spaceIdOf(message);
    if (!spaceId) return null;
    const accountId = message.accountId;
    const key = `${accountId}:${spaceId}`;

    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < ttl) return hit.blockText;
    const existing = inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        const ctx = await opts.fetchContext({ accountId, spaceId });
        if (!ctx) return null;
        const blockText = renderSpaceKnowledgeBlock(ctx);
        cache.set(key, { blockText, fetchedAt: now() });
        return blockText;
      } catch (err) {
        opts.log?.warn("daemon.space-knowledge.fetch-failed", {
          accountId,
          spaceId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}
