/**
 * [INPUT]: 依赖 backendDb + db/functions 获取公开房间摘要，依赖查询参数处理筛选与分页
 * [OUTPUT]: 对外提供公开房间列表 GET 路由，返回带最近消息预览的 public room 集合
 * [POS]: public rooms BFF 列表入口，被游客浏览、房间卡片与单房间详情回退复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { NextRequest, NextResponse } from "next/server";
import { backendDb, isBackendDbConfigured, backendDbConfigError } from "@/../db/backend";
import { rooms } from "@/../db/backend-schema";
import { eq, count, ilike, and, sql } from "drizzle-orm";
import { escapeLike } from "@/app/api/_helpers";

function dedupeRoomsById<T extends { room_id: string }>(rooms: T[]): T[] {
  const seen = new Set<string>();
  return rooms.filter((room) => {
    if (seen.has(room.room_id)) {
      return false;
    }
    seen.add(room.room_id);
    return true;
  });
}

export async function GET(request: NextRequest) {
  if (!isBackendDbConfigured) {
    return NextResponse.json({ error: backendDbConfigError }, { status: 503 });
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q") || "";
  const roomId = searchParams.get("room_id");
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "20", 10), 1), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10), 0);

  const conditions = [eq(rooms.visibility, "public")];
  if (roomId) {
    conditions.push(eq(rooms.roomId, roomId));
  }
  if (q) {
    const escaped = escapeLike(q);
    conditions.push(ilike(rooms.name, `%${escaped}%`));
  }

  const whereClause = and(...conditions);

  const [totalResult] = await backendDb
    .select({ count: count() })
    .from(rooms)
    .where(whereClause);

  const roomRows = await backendDb.execute<{
    room_id: string;
    room_name: string;
    room_description: string;
    room_rule: string | null;
    required_subscription_product_id: string | null;
    owner_id: string;
    visibility: string;
    join_policy: string;
    max_members: number | null;
    created_at: string;
    member_count: number;
    last_message_preview: string | null;
    last_message_at: string | null;
    last_sender_name: string | null;
  }>(sql`
    select *
    from public.get_public_room_previews(
      ${limit},
      ${offset},
      ${q || null},
      ${roomId || null},
      ${"recent"}
    )
  `);

  const normalizedRooms = dedupeRoomsById(
    roomRows.map((room) => ({
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
  );

  return NextResponse.json({
    total: totalResult.count,
    limit,
    offset,
    rooms: normalizedRooms,
  });
}
