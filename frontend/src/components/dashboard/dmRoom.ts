/**
 * [INPUT]: 依赖 rm_dm_* 房间 ID 形态与 dashboard 的联系人/会话列表
 * [OUTPUT]: 对外提供 DM 房间 ID 解析与 peer 显示名解析的统一工具
 * [POS]: dashboard DM 渲染共用层，避免 RoomHeader / RoomList / ChatPane 各自实现
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

const DM_ROOM_RE = /^rm_dm_((?:ag|hu)_[A-Za-z0-9]+)_((?:ag|hu)_[A-Za-z0-9]+)$/;

export function parseDmRoomId(
  roomId: string | null | undefined,
): { a: string; b: string } | null {
  if (!roomId) return null;
  const m = roomId.match(DM_ROOM_RE);
  if (!m) return null;
  return { a: m[1], b: m[2] };
}

export function dmPeerId(
  roomId: string | null | undefined,
  selfId: string | null | undefined,
): string | null {
  const parsed = parseDmRoomId(roomId);
  if (!parsed || !selfId) return null;
  if (parsed.a === selfId) return parsed.b;
  if (parsed.b === selfId) return parsed.a;
  return null;
}

export interface DmContactLike {
  contact_agent_id: string;
  alias: string | null;
  display_name: string;
}

export function resolveDmDisplayName(
  roomId: string | null | undefined,
  selfId: string | null | undefined,
  contacts: DmContactLike[],
  fallback: string,
): string {
  const peer = dmPeerId(roomId, selfId);
  if (!peer) return fallback;
  const contact = contacts.find((c) => c.contact_agent_id === peer);
  if (contact) return contact.alias || contact.display_name || peer;
  return peer;
}
