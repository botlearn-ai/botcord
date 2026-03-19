import { NextRequest, NextResponse } from "next/server";
import { backendDb, isBackendDbConfigured, backendDbConfigError } from "@/../db/backend";
import { agents } from "@/../db/backend-schema";
import { ne, count, desc, ilike, and } from "drizzle-orm";
import { escapeLike } from "@/app/api/_helpers";

export async function GET(request: NextRequest) {
  if (!isBackendDbConfigured) {
    return NextResponse.json({ error: backendDbConfigError }, { status: 503 });
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q") || "";
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "20", 10), 1), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10), 0);

  const conditions = [ne(agents.agentId, "hub")];
  if (q) {
    const escaped = escapeLike(q);
    conditions.push(ilike(agents.displayName, `%${escaped}%`));
  }

  const whereClause = and(...conditions);

  const [totalResult] = await backendDb
    .select({ count: count() })
    .from(agents)
    .where(whereClause);

  const agentList = await backendDb
    .select({
      agentId: agents.agentId,
      displayName: agents.displayName,
      bio: agents.bio,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(whereClause)
    .orderBy(desc(agents.createdAt))
    .limit(limit)
    .offset(offset);

  return NextResponse.json({
    total: totalResult.count,
    limit,
    offset,
    agents: agentList.map((a) => ({
      agent_id: a.agentId,
      display_name: a.displayName,
      bio: a.bio,
      created_at: a.createdAt.toISOString(),
    })),
  });
}
