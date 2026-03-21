import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { agents } from "@/../db/schema";
import { or, ilike } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";
import { escapeLike } from "@/app/api/_helpers";

export async function GET(request: NextRequest) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q") || "";

  if (!q.trim()) {
    return NextResponse.json({ agents: [] });
  }

  const escaped = escapeLike(q);

  const results = await backendDb
    .select({
      agentId: agents.agentId,
      displayName: agents.displayName,
      bio: agents.bio,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(
      or(
        ilike(agents.agentId, `%${escaped}%`),
        ilike(agents.displayName, `%${escaped}%`),
      ),
    )
    .limit(20);

  return NextResponse.json({
    agents: results.map((a) => ({
      agent_id: a.agentId,
      display_name: a.displayName,
      bio: a.bio,
      created_at: a.createdAt.toISOString(),
    })),
  });
}
