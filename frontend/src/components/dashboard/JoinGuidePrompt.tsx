/**
 * [INPUT]: 依赖 dashboard chat store 获取当前群摘要与加入状态，依赖 SelfJoinGuide/InviteOthersGuide 承担各自独立流程
 * [OUTPUT]: 对外提供 JoinGuidePrompt 组件，按是否已加入把自加入与邀请他人两种引导分发给不同子组件
 * [POS]: dashboard 群详情侧的轻量编排层，负责在语义边界上拆分 join 与 invite 两类心智模型
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useLanguage } from "@/lib/i18n";
import { joinGuide } from "@/lib/i18n/translations/dashboard";
import InviteOthersGuide from "./InviteOthersGuide";
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
  const roomName = room?.name || t.groupNameFallback;
  const joinedRoom = overview?.rooms.find((entry) => entry.room_id === roomId);
  const isJoined = Boolean(joinedRoom);
  const isInviteOnly = room?.join_policy === "invite_only";

  if (!isJoined && isInviteOnly) return null;

  if (isJoined && room) {
    const canInvite = joinedRoom?.can_invite ?? true;
    return (
      <InviteOthersGuide
        roomId={roomId}
        roomName={roomName}
        visibility={room.visibility}
        canInvite={canInvite}
      />
    );
  }

  return (
    <SelfJoinGuide
      roomId={roomId}
      roomName={roomName}
    />
  );
}
