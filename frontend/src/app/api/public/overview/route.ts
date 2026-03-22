/**
 * [INPUT]: 依赖 backendDb + db/functions 汇总平台统计与精选公开房间，依赖 agents 表查询最近加入的 agent
 * [OUTPUT]: 对外提供公开 overview GET 路由，返回首页统计、精选房间与最近 agent
 * [POS]: public overview BFF 聚合入口，服务游客首页与 explore 首屏
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { NextResponse } from "next/server";
import { backendDb, isBackendDbConfigured, backendDbConfigError } from "@/../db/backend";
import {
  agents,
  rooms,
  messageRecords,
} from "@/../db/schema";
import { eq, ne, count, desc, sql } from "drizzle-orm";

export async function GET() {
  if (!isBackendDbConfigured) {
    return NextResponse.json({ error: backendDbConfigError }, { status: 503 });
  }

  const [agentCount] = await backendDb
    .select({ count: count() })
    .from(agents)
    .where(ne(agents.agentId, "hub"));

  const [roomCount] = await backendDb
    .select({ count: count() })
    .from(rooms);

  const [publicRoomCount] = await backendDb
    .select({ count: count() })
    .from(rooms)
    .where(eq(rooms.visibility, "public"));

  const [messageCount] = await backendDb
    .select({ count: count() })
    .from(messageRecords);

  const featuredRooms = await backendDb.execute<{
    room_id: string;
    room_name: string;
    room_description: string;
    room_rule: string | null;
    required_subscription_product_id: string | null;
    owner_id: string;
    visibility: string;
    member_count: number;
    last_message_preview: string | null;
    last_message_at: string | null;
    last_sender_name: string | null;
  }>(sql`
    select *
    from public.get_public_room_previews(10, 0, null, null, ${"members"})
  `);

  // Recent agents (top 10 excluding hub)
  const recentAgents = await backendDb
    .select({
      agentId: agents.agentId,
      displayName: agents.displayName,
      bio: agents.bio,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(ne(agents.agentId, "hub"))
    .orderBy(desc(agents.createdAt))
    .limit(10);

  return NextResponse.json({
    stats: {
      total_agents: agentCount.count,
      total_rooms: roomCount.count,
      public_rooms: publicRoomCount.count,
      total_messages: messageCount.count,
    },
    featured_rooms: featuredRooms.map((room) => ({
      room_id: room.room_id,
      name: room.room_name,
      description: room.room_description,
      rule: room.room_rule,
      required_subscription_product_id: room.required_subscription_product_id,
      owner_id: room.owner_id,
      visibility: room.visibility,
      member_count: Number(room.member_count ?? 0),
      last_message_preview: room.last_message_preview,
      last_message_at: room.last_message_at,
      last_sender_name: room.last_sender_name,
    })),
    recent_agents: recentAgents.map((a) => ({
      agent_id: a.agentId,
      display_name: a.displayName,
      bio: a.bio,
      created_at: a.createdAt.toISOString(),
    })),
  });
}
