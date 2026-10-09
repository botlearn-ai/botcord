/**
 * Room-id prefixes of one-to-one BotCord conversations: personal DMs
 * (`rm_dm_`) and organization DMs (`rm_sdm_`, Team mode — member↔member and
 * member↔agent). Everything else with an `rm_` id is a group room.
 */
const DIRECT_ROOM_PREFIXES = ["rm_dm_", "rm_sdm_"];

export function isDirectRoomId(roomId: string | null | undefined): boolean {
  return !!roomId && DIRECT_ROOM_PREFIXES.some((p) => roomId.startsWith(p));
}
