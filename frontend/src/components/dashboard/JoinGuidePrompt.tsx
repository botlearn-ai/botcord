/**
 * [INPUT]: dashboard chat store 获取当前群摘要与加入状态
 * [OUTPUT]: 对外提供 JoinGuidePrompt 组件，仅在"未加入"时渲染 SelfJoinGuide；邀请他人入口已迁移到 Header 的分享按钮
 * [POS]: dashboard 群详情侧的轻量编排层，仅处理"自加入"单一心智模型
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useLanguage } from "@/lib/i18n";
import { joinGuide } from "@/lib/i18n/translations/dashboard";
import SelfJoinGuide from "./SelfJoinGuide";

interface JoinGuidePromptProps {
  roomId: string;
}

export default function JoinGuidePrompt({ roomId }: JoinGuidePromptProps) {
  const locale = useLanguage();
  const t = joinGuide[locale];
  const { overview, getRoomSummary } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    getRoomSummary: state.getRoomSummary,
  })));
  const room = getRoomSummary(roomId);
  const roomName = room?.name || t.roomNameFallback;
  // Wait for overview to load before deciding — otherwise isJoined is
  // falsely false on first paint and the self-join guide flashes for members.
  if (!overview) return null;
  const joinedRoom = overview.rooms.find((entry) => entry.room_id === roomId);
  const isJoined = Boolean(joinedRoom);
  const isInviteOnly = room?.join_policy === "invite_only";

  if (isJoined) return null;
  if (isInviteOnly) return null;

  return (
    <SelfJoinGuide
      roomId={roomId}
      roomName={roomName}
    />
  );
}
