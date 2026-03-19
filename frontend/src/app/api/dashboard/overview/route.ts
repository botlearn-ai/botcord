/**
 * [INPUT]: 依赖 requireAgent 获取当前 agent，依赖 backendDb + db/functions 聚合房间预览与联系人摘要
 * [OUTPUT]: 对外提供 dashboard overview GET 路由，返回当前 agent 的资料、房间列表与联系人概览
 * [POS]: dashboard BFF 聚合入口，服务 /chats 登录态首屏与会话列表
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import {
  agents,
  contacts,
  contactRequests,
} from "@/../db/backend-schema";
import { eq, and, count, sql } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";

export async function GET() {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;

  // Agent profile
  const [profile] = await backendDb
    .select({
      agentId: agents.agentId,
      displayName: agents.displayName,
      bio: agents.bio,
      messagePolicy: agents.messagePolicy,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(eq(agents.agentId, agentId))
    .limit(1);

  if (!profile) {
    return NextResponse.json({ error: "Agent not found in backend" }, { status: 404 });
  }

  const roomRows = await backendDb.execute<{
    room_id: string;
    room_name: string;
    room_description: string;
    room_rule: string | null;
    required_subscription_product_id: string | null;
    owner_id: string;
    visibility: string;
    my_role: string;
    member_count: number;
    last_message_preview: string | null;
    last_message_at: string | null;
    last_sender_name: string | null;
  }>(sql`
    select *
    from public.get_agent_room_previews(${agentId})
    order by last_message_at desc nulls last, room_id asc
  `);

  // Contacts
  const contactList = await backendDb
    .select({
      contactAgentId: contacts.contactAgentId,
      alias: contacts.alias,
      createdAt: contacts.createdAt,
      displayName: agents.displayName,
      bio: agents.bio,
    })
    .from(contacts)
    .innerJoin(agents, eq(contacts.contactAgentId, agents.agentId))
    .where(eq(contacts.ownerId, agentId));

  // Pending contact request count
  const [pendingCount] = await backendDb
    .select({ count: count() })
    .from(contactRequests)
    .where(and(eq(contactRequests.toAgentId, agentId), eq(contactRequests.state, "pending")));

  return NextResponse.json({
    agent: {
      agent_id: profile.agentId,
      display_name: profile.displayName,
      bio: profile.bio,
      message_policy: profile.messagePolicy,
      created_at: profile.createdAt.toISOString(),
    },
    rooms: roomRows.map((room) => ({
      room_id: room.room_id,
      name: room.room_name,
      description: room.room_description,
      rule: room.room_rule,
      required_subscription_product_id: room.required_subscription_product_id,
      owner_id: room.owner_id,
      visibility: room.visibility,
      member_count: Number(room.member_count ?? 0),
      my_role: room.my_role,
      last_message_preview: room.last_message_preview,
      last_message_at: room.last_message_at,
      last_sender_name: room.last_sender_name,
    })),
    contacts: contactList.map((c) => ({
      contact_agent_id: c.contactAgentId,
      alias: c.alias,
      display_name: c.displayName,
      created_at: c.createdAt.toISOString(),
    })),
    pending_requests: pendingCount.count,
  });
}
