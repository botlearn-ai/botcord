import { headers } from "next/headers";
import { requireAuth } from "@/lib/auth";
import { db } from "@/../db";
import { agents } from "@/../db/schema";
import { and, eq } from "drizzle-orm";

export async function requireAgent(): Promise<
  | { agentId: string; userId: string; error: null }
  | { agentId: null; userId: null; error: { status: number; message: string } }
> {
  const auth = await requireAuth();
  if (auth.error) {
    return { agentId: null, userId: null, error: auth.error };
  }

  const headerStore = await headers();
  const activeAgentId = headerStore.get("x-active-agent");

  if (!activeAgentId) {
    return {
      agentId: null,
      userId: null,
      error: { status: 400, message: "X-Active-Agent header is required" },
    };
  }

  const [agent] = await db
    .select({ agentId: agents.agentId })
    .from(agents)
    .where(and(eq(agents.userId, auth.user.id), eq(agents.agentId, activeAgentId)))
    .limit(1);

  if (!agent) {
    return {
      agentId: null,
      userId: null,
      error: { status: 403, message: "Agent does not belong to this user" },
    };
  }

  return { agentId: agent.agentId, userId: auth.user.id, error: null };
}
