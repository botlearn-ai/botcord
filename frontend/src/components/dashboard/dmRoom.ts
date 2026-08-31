/**
 * [INPUT]: 依赖 rm_dm_* 房间 ID 形态与 dashboard 的联系人/会话列表
 * [OUTPUT]: 对外提供 DM 房间 ID 解析与标题/peer 显示名解析的统一工具
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

export interface DmMemberLike {
  agent_id?: string | null;
  display_name: string;
}

type DmTitleLocale = "en" | "zh";

function dmMemberNames(
  roomId: string | null | undefined,
  members: DmMemberLike[] | null | undefined,
): [string, string] | null {
  const parsed = parseDmRoomId(roomId);
  if (!parsed || !members || members.length < 2) return null;

  const namesById = new Map(
    members
      .filter((member) => member.agent_id && member.display_name.trim())
      .map((member) => [member.agent_id!, member.display_name.trim()]),
  );
  const first = namesById.get(parsed.a);
  const second = namesById.get(parsed.b);
  return first && second ? [first, second] : null;
}

function observedBotDmTitle(
  roomId: string | null | undefined,
  members: DmMemberLike[] | null | undefined,
  locale: DmTitleLocale,
): string | null {
  const parsed = parseDmRoomId(roomId);
  if (!parsed || !parsed.a.startsWith("ag_") || !parsed.b.startsWith("ag_")) return null;

  const names = dmMemberNames(roomId, members);
  if (!names) return null;
  return locale === "zh"
    ? `${names[0]} & ${names[1]} 的私聊`
    : `${names[0]} & ${names[1]} private chat`;
}

export function resolveDmDisplayName(
  roomId: string | null | undefined,
  selfId: string | null | undefined,
  contacts: DmContactLike[],
  fallback: string,
  members?: DmMemberLike[] | null,
  locale: DmTitleLocale = "en",
): string {
  const peer = dmPeerId(roomId, selfId);
  if (peer) {
    const contact = contacts.find((c) => c.contact_agent_id === peer);
    if (contact) return contact.alias || contact.display_name || peer;
    const memberName = dmMemberNames(roomId, members)?.[
      parseDmRoomId(roomId)?.a === peer ? 0 : 1
    ];
    return memberName || peer;
  }

  // A Human owner observing a bot-to-bot DM is not one of its participants.
  // In that case, show both Bot names instead of the persisted legacy ID title.
  return observedBotDmTitle(roomId, members, locale) || fallback;
}
