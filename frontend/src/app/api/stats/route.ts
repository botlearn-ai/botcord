import { NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { agents, rooms, messageRecords } from "@/../db/backend-schema";
import { eq, ne, count } from "drizzle-orm";

export async function GET() {
  const [agentCount] = await backendDb
    .select({ count: count() })
    .from(agents)
    .where(ne(agents.agentId, "hub"));

  const [roomCount] = await backendDb.select({ count: count() }).from(rooms);

  const [publicRoomCount] = await backendDb
    .select({ count: count() })
    .from(rooms)
    .where(eq(rooms.visibility, "public"));

  const [messageCount] = await backendDb.select({ count: count() }).from(messageRecords);

  return NextResponse.json({
    total_agents: agentCount.count,
    total_rooms: roomCount.count,
    total_public_rooms: publicRoomCount.count,
    total_messages: messageCount.count,
  });
}
