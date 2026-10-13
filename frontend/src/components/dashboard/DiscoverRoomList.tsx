/**
 * [INPUT]: 依赖 chat store 的 discover 房间集合与加入动作，依赖 SubscriptionBadge 提供付费订阅入口
 * [OUTPUT]: 对外提供 DiscoverRoomList 组件，渲染可发现房间及其加入操作
 * [POS]: dashboard explore 房间列表，被登录态 discover 视图消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { roomList } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
import { useShallow } from "zustand/react/shallow";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { BotCordLoadingBlock } from "@/components/ui/BotCordLoader";
import SubscriptionBadge from "./SubscriptionBadge";

export default function DiscoverRoomList() {
  const locale = useLanguage();
  const t = roomList[locale];
  const tc = common[locale];
  const { discoverRooms, discoverLoading, joiningRoomId, loadDiscoverRooms, joinRoom } = useDashboardChatStore(
    useShallow((state) => ({
      discoverRooms: state.discoverRooms,
      discoverLoading: state.discoverLoading,
      joiningRoomId: state.joiningRoomId,
      loadDiscoverRooms: state.loadDiscoverRooms,
      joinRoom: state.joinRoom,
    })),
  );

  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    if (discoverRooms.length > 0 || discoverLoading) return;
    autoLoadedRef.current = true;
    void loadDiscoverRooms();
  }, [discoverRooms.length, discoverLoading, loadDiscoverRooms]);

  if (discoverLoading && discoverRooms.length === 0) {
    return (
      <BotCordLoadingBlock
        label={t.loadingRooms}
        className="p-4"
      />
    );
  }

  if (discoverRooms.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        {t.noRoomsToDiscover}
      </div>
    );
  }

  return (
    <div className="py-1">
      {discoverRooms.map((room) => {
        const isJoining = joiningRoomId === room.room_id;
        return (
          <Card padding="sm"
            key={room.room_id}
            className=""
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-sm font-medium text-text-primary">
                  {room.name}
                </span>
                {room.required_subscription_product_id && (
                  <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                )}
              </div>
              <span className="ml-2 shrink-0 text-xs text-text-secondary">
                {room.member_count}
              </span>
            </div>
            {room.description && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {room.description}
              </p>
            )}
            {room.rule && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                <span className="text-text-secondary">{t.rule}</span>
                {room.rule}
              </p>
            )}
            {room.required_subscription_product_id ? (
              <SubscriptionBadge
                productId={room.required_subscription_product_id}
                roomId={room.room_id}
                variant="button"
                triggerLabel={t.join}
                className="mt-1.5"
              />
            ) : room.join_policy === "invite_only" ? (
              <InviteOnlyJoinButton roomId={room.room_id} />
            ) : (
              <Button variant="secondary" size="sm"
                onClick={() => void joinRoom(room.room_id)}
                disabled={isJoining}
                className="mt-1.5 inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                {isJoining ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {isJoining ? t.joining : t.join}
              </Button>
            )}
          </Card>
        );
      })}
      <Button variant="ghost" size="sm"
        onClick={() => void loadDiscoverRooms()}
        disabled={discoverLoading}
        className="inline-flex w-full items-center justify-center gap-1.5 disabled:opacity-60"
      >
        {discoverLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {tc.refresh}
      </Button>
    </div>
  );
}

function InviteOnlyJoinButton({ roomId }: { roomId: string }) {
  const locale = useLanguage();
  const t = roomList[locale];
  const { joinRoom, joiningRoomId } = useDashboardChatStore(useShallow((state) => ({
    joinRoom: state.joinRoom,
    joiningRoomId: state.joiningRoomId,
  })));
  const setError = useDashboardChatStore((state) => state.setError);
  const [status, setStatus] = useState<"idle" | "sending" | "pending" | "accepted" | "rejected">("idle");

  useEffect(() => {
    let cancelled = false;
    api.getMyJoinRequest(roomId).then((res) => {
      if (cancelled) return;
      if (res.has_request && res.request) {
        const s = res.request.status;
        if (s === "pending" || s === "accepted" || s === "rejected") setStatus(s);
      }
    }).catch((err) => {
      if (!cancelled) console.warn("Failed to fetch join request status:", err);
    });
    return () => { cancelled = true; };
  }, [roomId]);

  const handleRequest = useCallback(async () => {
    setStatus("sending");
    try {
      await api.createJoinRequest(roomId);
      setStatus("pending");
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : t.joinFailed);
    }
  }, [roomId, setError, t.joinFailed]);

  if (status === "accepted") {
    const isJoining = joiningRoomId === roomId;
    return (
      <Button variant="secondary" size="sm"
        onClick={() => void joinRoom(roomId)}
        disabled={isJoining}
        className="mt-1.5 inline-flex items-center gap-1.5 disabled:opacity-40"
      >
        {isJoining ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {isJoining ? t.joining : t.join}
      </Button>
    );
  }
  if (status === "pending") {
    return (
      <Badge tone="warning" className="mt-1.5">
        {t.requestPending}
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge tone="danger" className="mt-1.5">
        {t.requestRejected}
      </Badge>
    );
  }
  return (
    <Button variant="secondary" size="sm"
      onClick={() => void handleRequest()}
      disabled={status === "sending"}
      className="mt-1.5 inline-flex items-center gap-1.5 disabled:opacity-40"
    >
      {status === "sending" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {status === "sending" ? t.joining : t.requestToJoin}
    </Button>
  );
}
