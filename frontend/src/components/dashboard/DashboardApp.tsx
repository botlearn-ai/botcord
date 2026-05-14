"use client";

/**
 * [INPUT]: 依赖 session/ui/chat/realtime/unread/contact/wallet 多业务 store 聚合 dashboard 状态，依赖 pathname 同步首帧 tab，依赖 react effect 在后台预热跨 tab 数据与 Supabase Realtime 订阅，依赖 Sidebar/ChatPane/WalletPanel/AgentCardModal 组织主界面
 * [OUTPUT]: 对外提供 DashboardApp 组件，负责鉴权初始化、请求闸门、realtime 生命周期与三栏布局编排
 * [POS]: /chats 页面的顶层容器，连接路由状态、实时事件流与拆分后的 dashboard store
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { useLanguage } from "@/lib/i18n";
import { sidebar as sidebarI18n, chatPane as chatPaneI18n } from "@/lib/i18n/translations/dashboard";
import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "nextjs-toploader/app";
import { createClient } from "@/lib/supabase/client";
import { api, humansApi } from "@/lib/api";
import type { PublicHumanProfile, RealtimeMetaEvent } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardRealtimeStore } from "@/store/useDashboardRealtimeStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { usePresenceStore } from "@/store/usePresenceStore";
import AgentBrowser from "./AgentBrowser";
import AgentCardModal from "./AgentCardModal";
import AgentGateModal from "./AgentGateModal";
import BotDetailDrawer from "./BotDetailDrawer";
import DeviceDetailDrawer from "./DeviceDetailDrawer";
import PeerBotDetailDrawer from "./PeerBotDetailDrawer";
import ChatPane from "./ChatPane";
import ContactRequestsInbox from "./ContactRequestsInbox";
import DashboardShellSkeleton from "./DashboardShellSkeleton";
import DashboardTabSkeleton from "./DashboardTabSkeleton";
import HomePanel from "./HomePanel";
import MyBotsPanel from "./MyBotsPanel";
import HumanCardModal from "./HumanCardModal";
import Sidebar from "./sidebar";
import StripeReturnBanner from "./StripeReturnBanner";
import UserChatPane from "./UserChatPane";
import WalletPanel from "./WalletPanel";
import ActivityPanel from "./ActivityPanel";

const USER_CHAT_SUBTAB = "__user-chat__";
type DashboardSidebarTab = "home" | "messages" | "contacts" | "explore" | "wallet" | "activity" | "bots";

type BotcordDebugRealtimeSnapshot = {
  supabaseUrl: string | undefined;
  authResolved: boolean;
  sessionMode: string;
  activeAgentId: string | null;
  topic: string | null;
  realtimeStatus: string;
  realtimeError: string | null;
  browserUserId: string | null;
  browserEmail: string | null;
  accessTokenSub: string | null;
  accessTokenRole: string | null;
};

function decodeRoomIdFromPath(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function getCurrentMessageRoomFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "chats" || parts[1] !== "messages") return null;
  const subtab = parts[2];
  if (!subtab || subtab === USER_CHAT_SUBTAB) return null;
  return decodeRoomIdFromPath(subtab);
}

function getSidebarTabFromPathParts(parts: string[]): DashboardSidebarTab {
  const tab = parts[1];
  if (tab === "dm" || tab === "rooms" || tab === "messages" || tab === "user-chat") return "messages";
  if (
    tab === "contacts"
    || tab === "explore"
    || tab === "wallet"
    || tab === "activity"
    || tab === "bots"
  ) {
    return tab;
  }
  return "home";
}

export default function DashboardApp() {
  const sessionStore = useDashboardSessionStore();
  const uiStore = useDashboardUIStore();
  const chatStore = useDashboardChatStore();
  const realtimeStore = useDashboardRealtimeStore();
  const unreadStore = useDashboardUnreadStore();
  const walletStore = useDashboardWalletStore();
  const contactStore = useDashboardContactStore();
  const subscriptionStore = useDashboardSubscriptionStore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const locale = useLanguage();
  const tSidebar = sidebarI18n[locale];
  const tChatPane = chatPaneI18n[locale];
  // Wallet is keyed on the active identity (agent OR human), since both
  // can own a wallet (`backend/app/routers/wallet.py:_resolve_owner`).
  const walletBoundIdentityRef = useRef<string | null>(null);
  const contactBoundAgentRef = useRef<string | null>(null);
  const subscriptionBoundAgentRef = useRef<string | null>(null);
  const initResolvedRef = useRef(false);
  const lastAccessTokenRef = useRef<string | null>(null);
  const pathnameParts = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);
  const routeSidebarTab = useMemo(() => getSidebarTabFromPathParts(pathnameParts), [pathnameParts]);
  const userChatAgentIdFromQuery = searchParams.get("agent_id");
  const shouldShowBootstrapSkeleton = !sessionStore.authResolved || sessionStore.authBootstrapping;
  // Human-first: never force-block on "no agent". Authed users always proceed
  // into /chats as their Human identity; creating an Agent is a later,
  // optional CTA. AgentGateModal is kept for manual entry points (account
  // menu, etc.) but must never auto-mount.
  const shouldShowAgentGate = false;
  const continueTarget = searchParams.get("next");
  const continueHandledRef = useRef<string | null>(null);
  const [ownerHumanCard, setOwnerHumanCard] = useState<{
    human: PublicHumanProfile | null;
    loading: boolean;
    error: string | null;
    sending: boolean;
    status: "idle" | "sent" | "exists" | "pending";
  } | null>(null);

  useEffect(() => {
    const debugRealtime = async (): Promise<BotcordDebugRealtimeSnapshot> => {
      const [{ data: { user } }, { data: { session } }] = await Promise.all([
        supabase.auth.getUser(),
        supabase.auth.getSession(),
      ]);
      const accessTokenClaims = (() => {
        const token = session?.access_token;
        if (!token) return null;
        try {
          return JSON.parse(atob(token.split(".")[1] ?? ""));
        } catch {
          return null;
        }
      })();
      const snapshot: BotcordDebugRealtimeSnapshot = {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        authResolved: useDashboardSessionStore.getState().authResolved,
        sessionMode: useDashboardSessionStore.getState().sessionMode,
        activeAgentId: useDashboardSessionStore.getState().activeAgentId,
        topic: useDashboardSessionStore.getState().activeAgentId
          ? `agent:${useDashboardSessionStore.getState().activeAgentId}`
          : null,
        realtimeStatus: useDashboardRealtimeStore.getState().realtimeStatus,
        realtimeError: useDashboardRealtimeStore.getState().realtimeError,
        browserUserId: user?.id ?? null,
        browserEmail: user?.email ?? null,
        accessTokenSub: typeof accessTokenClaims?.sub === "string" ? accessTokenClaims.sub : null,
        accessTokenRole: typeof accessTokenClaims?.role === "string" ? accessTokenClaims.role : null,
      };
      console.group("[BotCord][Realtime] Debug Snapshot");
      console.log(snapshot);
      if (accessTokenClaims) {
        console.log("[BotCord][Realtime] Access Token Claims", accessTokenClaims);
      }
      console.groupEnd();
      return snapshot;
    };

    const target = window as typeof window & {
      botcordDebugRealtime?: () => Promise<BotcordDebugRealtimeSnapshot>;
    };
    target.botcordDebugRealtime = debugRealtime;

    console.info("[BotCord][Realtime] Global debug helper ready: window.botcordDebugRealtime()");

    return () => {
      delete target.botcordDebugRealtime;
    };
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;

    const syncSession = async (
      session: Pick<Session, "access_token"> | null,
      source: "getSession" | "authEvent",
      event?: string,
    ) => {
      if (cancelled) return;

      const accessToken = session?.access_token ?? null;
      const isSignOutEvent = event === "SIGNED_OUT";

      if (source === "authEvent" && !initResolvedRef.current && !accessToken && !isSignOutEvent) return;

      if (accessToken) {
        if (lastAccessTokenRef.current === accessToken && useDashboardSessionStore.getState().authResolved) return;
        lastAccessTokenRef.current = accessToken;
        await sessionStore.initAuth(accessToken);
      } else {
        if (source === "authEvent" && !isSignOutEvent) return;
        lastAccessTokenRef.current = null;
        sessionStore.setToken(null);
      }

      initResolvedRef.current = true;
    };

    const resolveSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      await syncSession(session, "getSession");
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      void syncSession(session, "authEvent", _event);
    });

    void resolveSession();

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [sessionStore.initAuth, sessionStore.setToken, supabase]);

  useEffect(() => {
    if (!sessionStore.authResolved) return;

    const pendingPrimaryNavigation = uiStore.pendingPrimaryNavigation;
    if (pendingPrimaryNavigation) {
      if (pathname === pendingPrimaryNavigation.path) {
        uiStore.clearPrimaryNavigation();
      } else {
        return;
      }
    }

    // Previously: authed-no-agent short-circuited the router and forced
    // focusedRoomId=null, pairing with the AgentGateModal block. Human-first
    // drops that short-circuit so users without an Agent can still navigate
    // /chats/messages, /chats/explore, /chats/contacts etc. as their Human
    // identity.

    const tab = pathnameParts[1];
    const subtab = pathnameParts[2];
    const normalizedTab =
      tab === "dm" || tab === "rooms"
        ? "messages"
        : tab === "home" || tab === "messages" || tab === "contacts" || tab === "explore" || tab === "wallet" || tab === "activity" || tab === "user-chat" || tab === "bots"
          ? tab
          : null;

    if (normalizedTab) {
      const nextSidebarTab = normalizedTab === "user-chat" ? "messages" : normalizedTab;
      if (uiStore.sidebarTab !== nextSidebarTab) uiStore.setSidebarTab(nextSidebarTab);

      if (normalizedTab === "bots") {
        const botIdFromPath = subtab ? decodeRoomIdFromPath(subtab) : null;
        if (botIdFromPath !== uiStore.selectedBotAgentId) {
          uiStore.setSelectedBotAgentId(botIdFromPath);
        }
        return;
      }

      if (tab === "explore" && (subtab === "rooms" || subtab === "agents" || subtab === "humans") && uiStore.exploreView !== subtab) {
        uiStore.setExploreView(subtab);
      }

      if (
        tab === "contacts"
        && (subtab === "agents" || subtab === "requests" || subtab === "rooms" || subtab === "created")
        && uiStore.contactsView !== subtab
      ) {
        uiStore.setContactsView(subtab);
      }

      if (normalizedTab === "messages" || normalizedTab === "user-chat") {
        const roomIdFromSubtab = subtab && subtab !== USER_CHAT_SUBTAB ? decodeRoomIdFromPath(subtab) : null;
        const opensUserChat =
          tab === "user-chat"
          || subtab === USER_CHAT_SUBTAB
          || (roomIdFromSubtab !== null && (
            roomIdFromSubtab === uiStore.userChatRoomId
            || roomIdFromSubtab.startsWith("rm_oc_")
          ));
        if (opensUserChat) {
          const agentIdFromQuery = searchParams.get("agent_id");
          if (agentIdFromQuery && uiStore.userChatAgentId !== agentIdFromQuery) {
            uiStore.setUserChatAgentId(agentIdFromQuery);
          }
          if (roomIdFromSubtab?.startsWith("rm_oc_") && uiStore.userChatRoomId !== roomIdFromSubtab) {
            uiStore.setUserChatRoomId(roomIdFromSubtab);
          }
          if (uiStore.messagesPane !== "user-chat") uiStore.setMessagesPane("user-chat");
          if (uiStore.focusedRoomId !== null) uiStore.setFocusedRoomId(null);
          if (uiStore.openedRoomId !== null) uiStore.setOpenedRoomId(null);
          return;
        }
        if (uiStore.messagesPane !== "room") uiStore.setMessagesPane("room");
        const roomIdFromPath = subtab ? decodeRoomIdFromPath(subtab) : null;
        if (roomIdFromPath) {
          if (uiStore.focusedRoomId !== roomIdFromPath) uiStore.setFocusedRoomId(roomIdFromPath);
          if (uiStore.openedRoomId !== roomIdFromPath) uiStore.setOpenedRoomId(roomIdFromPath);

          const knownRoom =
            Boolean(chatStore.getRoomSummary(roomIdFromPath))
            || chatStore.discoverRooms.some((room) => room.room_id === roomIdFromPath);

          if (!knownRoom) {
            void chatStore.loadPublicRoomDetail(roomIdFromPath);
          }
          if (chatStore.messagesLoading[roomIdFromPath]) {
            return;
          }
          if (!chatStore.messages[roomIdFromPath]) {
            void chatStore.loadRoomMessages(roomIdFromPath);
          } else {
            void chatStore.pollNewMessages(roomIdFromPath);
          }
        } else {
          if (uiStore.focusedRoomId !== null) uiStore.setFocusedRoomId(null);
          if (uiStore.openedRoomId !== null) uiStore.setOpenedRoomId(null);
        }
      }
    } else if (uiStore.sidebarTab !== "home") {
      uiStore.setSidebarTab("home");
    }
  }, [
    sessionStore.authResolved,
    sessionStore.sessionMode,
    pathname,
    pathnameParts,
    uiStore.pendingPrimaryNavigation,
    uiStore.focusedRoomId,
    uiStore.openedRoomId,
    uiStore.sidebarTab,
    uiStore.messagesPane,
    uiStore.userChatRoomId,
    uiStore.userChatAgentId,
    uiStore.exploreView,
    uiStore.contactsView,
    uiStore.setFocusedRoomId,
    uiStore.setOpenedRoomId,
    uiStore.setSidebarTab,
    uiStore.clearPrimaryNavigation,
    uiStore.setMessagesPane,
    uiStore.setUserChatRoomId,
    uiStore.setUserChatAgentId,
    uiStore.setExploreView,
    uiStore.setContactsView,
    searchParams,
    chatStore.getRoomSummary,
    chatStore.discoverRooms,
    chatStore.messages,
    chatStore.loadPublicRoomDetail,
    chatStore.loadRoomMessages,
    chatStore.pollNewMessages,
  ]);

  useEffect(() => {
    // Human-first: when the user is authenticated but has no active Agent
    // (Human viewer mode), skip the agent-specific binding/reset cycle and
    // let refreshOverview() run on the Human anchor. Only drop back into the
    // full reset branch for truly pre-auth states.
    const walletIdentityKey = sessionStore.activeIdentity
      ? `${sessionStore.activeIdentity.type}:${sessionStore.activeIdentity.id}`
      : null;

    if (sessionStore.sessionMode === "authed-no-agent") {
      contactBoundAgentRef.current = null;
      subscriptionBoundAgentRef.current = null;
      if (walletBoundIdentityRef.current !== walletIdentityKey) {
        walletBoundIdentityRef.current = walletIdentityKey;
        walletStore.resetWalletState();
      }
      if (
        !chatStore.overview
        && !chatStore.overviewRefreshing
        && !chatStore.overviewErrored
        && uiStore.sidebarTab !== "wallet"
      ) {
        void chatStore.refreshOverview();
      }
      return;
    }

    if (sessionStore.sessionMode !== "authed-ready" || !sessionStore.activeAgentId) {
      walletBoundIdentityRef.current = null;
      contactBoundAgentRef.current = null;
      subscriptionBoundAgentRef.current = null;
      uiStore.resetUIState();
      chatStore.resetChatState();
      unreadStore.resetUnreadState();
      realtimeStore.resetRealtimeState();
      walletStore.resetWalletState();
      contactStore.resetContactState();
      subscriptionStore.resetSubscriptionState();
      return;
    }

    if (walletBoundIdentityRef.current !== walletIdentityKey) {
      walletBoundIdentityRef.current = walletIdentityKey;
      walletStore.resetWalletState();
    }
    if (contactBoundAgentRef.current !== sessionStore.activeAgentId) {
      contactBoundAgentRef.current = sessionStore.activeAgentId;
      contactStore.resetContactState();
    }
    if (subscriptionBoundAgentRef.current !== sessionStore.activeAgentId) {
      subscriptionBoundAgentRef.current = sessionStore.activeAgentId;
      subscriptionStore.resetSubscriptionState();
    }
    if (
      !chatStore.overview
      && !chatStore.overviewRefreshing
      && !chatStore.overviewErrored
      && uiStore.sidebarTab !== "wallet"
    ) {
      void chatStore.refreshOverview();
    }
  }, [
    sessionStore.sessionMode,
    sessionStore.activeAgentId,
    sessionStore.activeIdentity,
    uiStore.sidebarTab,
    uiStore.resetUIState,
    chatStore.overview,
    chatStore.overviewRefreshing,
    chatStore.overviewErrored,
    chatStore.resetChatState,
    chatStore.refreshOverview,
    unreadStore.resetUnreadState,
    realtimeStore.resetRealtimeState,
    walletStore.resetWalletState,
    contactStore.resetContactState,
    subscriptionStore.resetSubscriptionState,
  ]);

  useEffect(() => {
    if (!sessionStore.authResolved) return;
    // Human-first: fire for authenticated Human sessions, with or without a
    // selected managed Bot. Only stay idle for guest sessions.
    if (
      sessionStore.sessionMode !== "authed-ready"
      && sessionStore.sessionMode !== "authed-no-agent"
    ) {
      return;
    }
    if (uiStore.sidebarTab === "wallet" || uiStore.sidebarTab === "activity") return;
    if (chatStore.overview || chatStore.overviewRefreshing || chatStore.overviewErrored) return;
    void chatStore.refreshOverview();
  }, [
    sessionStore.authResolved,
    sessionStore.sessionMode,
    uiStore.sidebarTab,
    chatStore.overview,
    chatStore.overviewRefreshing,
    chatStore.overviewErrored,
    chatStore.refreshOverview,
  ]);

  // Eagerly register userChatRoomId so realtime events are always routed to the user-chat pane
  useEffect(() => {
    if (
      sessionStore.sessionMode !== "authed-ready"
      || !sessionStore.activeAgentId
    ) return;

    let cancelled = false;
    api.getUserChatRoom(sessionStore.activeAgentId).then((room) => {
      if (!cancelled) uiStore.setUserChatRoomId(room.room_id);
    }).catch(() => { /* ignore — UserChatPane will retry on mount */ });

    return () => { cancelled = true; };
  }, [
    sessionStore.sessionMode,
    sessionStore.activeAgentId,
    uiStore.setUserChatRoomId,
  ]);

  useEffect(() => {
    // The Messages list can contain rooms for both the logged-in Human and the
    // selected Agent. Subscribe to both anchors so ordinary room updates keep
    // working even when the viewer mode and visible room owner differ.
    const anchorMap = new Map<string, { kind: "agent" | "human"; id: string }>();
    if (sessionStore.authResolved && sessionStore.human?.human_id) {
      anchorMap.set(`human:${sessionStore.human.human_id}`, {
        kind: "human",
        id: sessionStore.human.human_id,
      });
    }
    if (sessionStore.authResolved && sessionStore.activeAgentId) {
      anchorMap.set(`agent:${sessionStore.activeAgentId}`, {
        kind: "agent",
        id: sessionStore.activeAgentId,
      });
    }
    const anchors = Array.from(anchorMap.entries());

    if (anchors.length === 0) {
      realtimeStore.setRealtimeStatus("idle");
      return;
    }

    let cancelled = false;
    const channels: ReturnType<typeof supabase.channel>[] = [];

    const subscribeRealtime = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      if (!accessToken) {
        console.warn("[BotCord][Realtime] missing access token before subscribe", {
          topics: anchors.map(([topic]) => topic),
          activeAgentId: sessionStore.activeAgentId,
        });
        realtimeStore.setRealtimeStatus("error", "realtime missing access token");
        return;
      }

      await supabase.realtime.setAuth(accessToken);
      if (cancelled) return;

      realtimeStore.setRealtimeStatus("connecting");
      console.info("[BotCord][Realtime] subscribing", {
        topics: anchors.map(([topic]) => topic),
        sessionMode: sessionStore.sessionMode,
      });

      anchors.forEach(([topic, anchor]) => {
        const anchorId = anchor.id;
        const channel = supabase.channel(topic, { config: { private: true } })
        .on("broadcast", { event: "*" }, ({ payload }: { payload: unknown }) => {
          const realtimeEvent = payload as RealtimeMetaEvent;
          // Backend populates ``agent_id`` with the recipient participant id
          // (``ag_*`` OR ``hu_*``) — topic dispatch in the backend already
          // narrows delivery per subscriber, so this check is a belt-and-
          // suspenders filter.
          if (!realtimeEvent?.type || realtimeEvent.agent_id !== anchorId) {
            return;
          }
          const currentUIState = useDashboardUIStore.getState();
          const currentPathRoomId = getCurrentMessageRoomFromPath(window.location.pathname);
          const isOpenedRoomEvent = Boolean(
            realtimeEvent.room_id
            && (
              realtimeEvent.room_id === currentUIState.openedRoomId
              || realtimeEvent.room_id === currentPathRoomId
              || realtimeEvent.room_id === currentUIState.userChatRoomId
            ),
          );
          console.info("[BotCord][Realtime] event", {
            topic,
            type: realtimeEvent.type,
            roomId: realtimeEvent.room_id,
            hubMsgId: realtimeEvent.hub_msg_id,
          });
          if (realtimeEvent.type === "agent_status_changed") {
            const ext = (realtimeEvent.ext || {}) as Record<string, unknown>;
            const status = ext.status as Record<string, unknown> | undefined;
            if (status && typeof status.agent_id === "string") {
              usePresenceStore.getState().upsertStatus(status as never);
            }
            return;
          }
          chatStore.applyRealtimeEventHint(realtimeEvent);
          if (anchor.kind === "human" && realtimeEvent.room_id) {
            void useDashboardSessionStore.getState().refreshHumanRooms();
          }
          if (!isOpenedRoomEvent) {
            unreadStore.applyRealtimeEvent(realtimeEvent);
          }
          void realtimeStore.syncRealtimeEvent(realtimeEvent);
        })
        .subscribe((status: string) => {
          console.info("[BotCord][Realtime] channel status", {
            topic,
            status,
          });
          if (status === "SUBSCRIBED") {
            realtimeStore.setRealtimeStatus("connected");
            // Refresh presence snapshots for any agents we're already tracking,
            // so we recover from events missed during the disconnect window.
            try {
              const tracked = Object.keys(usePresenceStore.getState().entries);
              if (tracked.length > 0) {
                void api
                  .getPresenceSnapshots(tracked)
                  .then((res) => usePresenceStore.getState().upsertMany(res.agents))
                  .catch(() => {});
              }
            } catch {}
            return;
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            realtimeStore.setRealtimeStatus("error", `realtime ${status.toLowerCase()}`);
          }
        });
        channels.push(channel);
      });
    };

    void subscribeRealtime();

    return () => {
      cancelled = true;
      console.info("[BotCord][Realtime] removing channel", {
        topics: anchors.map(([topic]) => topic),
      });
      for (const channel of channels) {
        void supabase.removeChannel(channel);
      }
    };
  }, [
    sessionStore.authResolved,
    sessionStore.sessionMode,
    sessionStore.activeAgentId,
    sessionStore.activeIdentity,
    sessionStore.human?.human_id,
    chatStore.applyRealtimeEventHint,
    unreadStore.applyRealtimeEvent,
    realtimeStore.setRealtimeStatus,
    realtimeStore.syncRealtimeEvent,
    supabase,
  ]);

  useEffect(() => {
    if (!sessionStore.authResolved) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const tracked = Object.keys(usePresenceStore.getState().entries);
      if (tracked.length === 0) return;
      void api
        .getPresenceSnapshots(tracked)
        .then((res) => usePresenceStore.getState().upsertMany(res.agents))
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sessionStore.authResolved]);

  useEffect(() => {
    if (!sessionStore.authResolved || !sessionStore.token || uiStore.sidebarTab !== "messages") {
      return;
    }

    let cancelled = false;
    let syncInFlight = false;

    const syncMessagesPane = async () => {
      if (cancelled || syncInFlight) return;
      syncInFlight = true;
      try {
        const { openedRoomId, messagesPane } = useDashboardUIStore.getState();
        const session = useDashboardSessionStore.getState();
        const chat = useDashboardChatStore.getState();
        await Promise.all([
          chat.refreshOverview(),
          session.human?.human_id ? session.refreshHumanRooms() : Promise.resolve(),
          session.activeIdentity?.type === "human" ? chat.loadOwnedAgentRooms() : Promise.resolve(),
          openedRoomId && messagesPane === "room"
            ? chat.pollNewMessages(openedRoomId)
            : Promise.resolve(),
        ]);
      } finally {
        syncInFlight = false;
      }
    };

    const intervalId = window.setInterval(syncMessagesPane, 5_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void syncMessagesPane();
      }
    };
    window.addEventListener("focus", syncMessagesPane);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", syncMessagesPane);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    sessionStore.authResolved,
    sessionStore.token,
    uiStore.sidebarTab,
  ]);

  useEffect(() => {
    if (!sessionStore.authResolved) return;

    if (!chatStore.publicRoomsLoaded && !chatStore.publicRoomsLoading) {
      void chatStore.loadPublicRooms();
    }
    if (!chatStore.publicAgentsLoaded && !chatStore.publicAgentsLoading) {
      void chatStore.loadPublicAgents();
    }
    if (!chatStore.publicHumansLoaded && !chatStore.publicHumansLoading) {
      void chatStore.loadPublicHumans();
    }
    if (
      sessionStore.activeIdentity?.type === "human"
      && !chatStore.ownedAgentRoomsLoaded
      && !chatStore.ownedAgentRoomsLoading
    ) {
      void chatStore.loadOwnedAgentRooms();
    }
  }, [
    sessionStore.authResolved,
    sessionStore.activeIdentity?.type,
    chatStore.publicRoomsLoaded,
    chatStore.publicRoomsLoading,
    chatStore.publicAgentsLoaded,
    chatStore.publicAgentsLoading,
    chatStore.publicHumansLoaded,
    chatStore.publicHumansLoading,
    chatStore.ownedAgentRoomsLoaded,
    chatStore.ownedAgentRoomsLoading,
    chatStore.loadPublicRooms,
    chatStore.loadPublicAgents,
    chatStore.loadPublicHumans,
    chatStore.loadOwnedAgentRooms,
  ]);

  useEffect(() => {
    // The authenticated Human owns a wallet; selected Bot wallets are explicit
    // viewer overrides elsewhere.
    if (
      sessionStore.sessionMode !== "authed-ready"
      && sessionStore.sessionMode !== "authed-no-agent"
    ) return;
    if (!sessionStore.activeIdentity) return;

    if (!walletStore.wallet && !walletStore.walletLoading && !walletStore.walletError) {
      void walletStore.loadWallet();
    }
    if (
      !walletStore.withdrawalRequestsLoaded
      && !walletStore.withdrawalRequestsLoading
      && !walletStore.withdrawalRequestsError
    ) {
      void walletStore.loadWithdrawalRequests();
    }
  }, [
    sessionStore.sessionMode,
    sessionStore.activeIdentity,
    walletStore.wallet,
    walletStore.walletLoading,
    walletStore.walletError,
    walletStore.withdrawalRequestsLoaded,
    walletStore.withdrawalRequestsLoading,
    walletStore.withdrawalRequestsError,
    walletStore.loadWallet,
    walletStore.loadWithdrawalRequests,
  ]);

  useEffect(() => {
    if (
      sessionStore.sessionMode !== "authed-ready"
      || !continueTarget
      || pathname !== "/chats"
      || continueHandledRef.current === continueTarget
    ) {
      return;
    }
    continueHandledRef.current = continueTarget;
    router.replace(continueTarget);
  }, [continueTarget, pathname, router, sessionStore.sessionMode]);

  const handleOpenHumanCard = async (owner: { humanId: string; displayName: string }) => {
    const placeholder: PublicHumanProfile = {
      human_id: owner.humanId,
      display_name: owner.displayName,
      avatar_url: null,
      created_at: null,
    };
    setOwnerHumanCard({
      human: placeholder,
      loading: true,
      error: null,
      sending: false,
      status: "idle",
    });
    try {
      const human = await api.getPublicHuman(owner.humanId);
      const localContact = (chatStore.overview?.contacts || []).some(
        (item) => item.contact_agent_id === owner.humanId,
      );
      const status =
        human.contact_status === "contact" || localContact ? "exists"
        : human.contact_status === "pending" ? "pending"
        : "idle";
      setOwnerHumanCard({
        human,
        loading: false,
        error: null,
        sending: false,
        status,
      });
    } catch (error) {
      setOwnerHumanCard((prev) => prev && {
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load human profile",
      });
    }
  };

  useEffect(() => {
    const pending = uiStore.pendingHumanOpen;
    if (!pending) return;
    void handleOpenHumanCard(pending);
    uiStore.clearPendingHumanOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiStore.pendingHumanOpen]);

  if (shouldShowBootstrapSkeleton) {
    return <DashboardShellSkeleton />;
  }

  const selectedAgentForCard = chatStore.selectedAgentProfile;
  const isSelectedAgentOwned = selectedAgentForCard
    ? selectedAgentForCard.agent_id === sessionStore.activeAgentId
      || sessionStore.ownedAgents.some(
        (item) => item.agent_id === selectedAgentForCard.agent_id,
      )
      || (
        Boolean(selectedAgentForCard.owner_human_id)
        && selectedAgentForCard.owner_human_id === sessionStore.human?.human_id
      )
    : false;
  const alreadyInContacts = selectedAgentForCard
    ? (chatStore.overview?.contacts || []).some(
      (item) => item.contact_agent_id === selectedAgentForCard.agent_id,
    )
    : false;
  const requestAlreadyPending = selectedAgentForCard
    ? contactStore.pendingFriendRequests.includes(selectedAgentForCard.agent_id)
      || contactStore.contactRequestsSent.some(
        (item) => item.to_agent_id === selectedAgentForCard.agent_id && item.state === "pending",
      )
    : false;
  const isSendingFriendRequest = selectedAgentForCard
    ? contactStore.sendingContactRequestAgentId === selectedAgentForCard.agent_id
    : false;

  const handleSendFriendRequestFromCard = () => {
    if (!selectedAgentForCard) return;
    if (isSelectedAgentOwned) return;
    if (sessionStore.sessionMode !== "authed-ready") {
      router.push("/login");
      return;
    }
    void contactStore.sendContactRequest(selectedAgentForCard.agent_id);
  };

  const navigateToDmWith = async (peerId: string, onClose: () => void) => {
    const selfId = sessionStore.human?.human_id ?? null;
    const predictedRoomId = selfId
      ? `rm_dm_${[selfId, peerId].sort().join("_")}`
      : null;
    const cachedRoom = predictedRoomId
      ? chatStore.overview?.rooms.find((r) => r.room_id === predictedRoomId)
      : null;
    onClose();
    uiStore.setSidebarTab("messages");

    // If the DM is already in the local rooms list, navigate immediately.
    if (cachedRoom) {
      uiStore.setFocusedRoomId(cachedRoom.room_id);
      uiStore.setOpenedRoomId(cachedRoom.room_id);
      router.push(`/chats/messages/${encodeURIComponent(cachedRoom.room_id)}`);
      return;
    }

    // Otherwise ensure the DM exists on the backend so RoomHeader and the
    // sidebar can hydrate before the user types anything. Falls back to a
    // pending placeholder navigation if the call fails (auto-create on first
    // send still kicks in via human_room_send).
    try {
      const { room_id } = await api.openDmRoom(peerId);
      if (sessionStore.viewMode === "human") {
        await sessionStore.refreshHumanRooms();
      } else {
        await chatStore.refreshOverview();
      }
      uiStore.setFocusedRoomId(room_id);
      uiStore.setOpenedRoomId(room_id);
      router.push(`/chats/messages/${encodeURIComponent(room_id)}`);
    } catch (error) {
      console.error("[DashboardApp] openDmRoom failed:", error);
      if (predictedRoomId) {
        uiStore.setFocusedRoomId(predictedRoomId);
        uiStore.setOpenedRoomId(predictedRoomId);
        router.push(`/chats/messages/${encodeURIComponent(predictedRoomId)}`);
      } else {
        router.push("/chats/messages");
      }
    }
  };

  const handleSendMessageFromAgentCard = () => {
    if (!selectedAgentForCard) return;
    if (isSelectedAgentOwned) {
      const agentId = selectedAgentForCard.agent_id;
      void (async () => {
        uiStore.closeAgentCard();
        chatStore.closeAgentCardState();
        uiStore.setSidebarTab("messages");
        uiStore.setMessagesPane("user-chat");
        uiStore.setUserChatAgentId(agentId);
        uiStore.setFocusedRoomId(null);
        uiStore.setOpenedRoomId(null);
        chatStore.upsertOptimisticOwnerChatRoom({
          agent_id: selectedAgentForCard.agent_id,
          display_name: selectedAgentForCard.display_name || selectedAgentForCard.agent_id,
        });
        api.getUserChatRoom(agentId).then((room) => {
          chatStore.upsertOptimisticOwnerChatRoom({
            agent_id: selectedAgentForCard.agent_id,
            display_name: selectedAgentForCard.display_name || selectedAgentForCard.agent_id,
          }, room.room_id);
          uiStore.setUserChatRoomId(room.room_id);
          void chatStore.loadOwnedAgentRooms();
        }).catch((error) => {
          console.error("[DashboardApp] getUserChatRoom failed:", error);
        });
        router.push(`/chats/messages/${USER_CHAT_SUBTAB}`);
      })();
      return;
    }
    void navigateToDmWith(selectedAgentForCard.agent_id, () => {
      uiStore.closeAgentCard();
      chatStore.closeAgentCardState();
    });
  };

  const handleSendMessageFromHumanCard = () => {
    const human = ownerHumanCard?.human;
    if (!human) return;
    void navigateToDmWith(human.human_id, () => setOwnerHumanCard(null));
  };

  const handleRetryOwnerHumanCard = () => {
    const human = ownerHumanCard?.human;
    if (!human) return;
    void handleOpenHumanCard({
      humanId: human.human_id,
      displayName: human.display_name,
    });
  };

  const handleSendOwnerHumanFriendRequest = async () => {
    const human = ownerHumanCard?.human;
    if (!human) return;
    if (sessionStore.sessionMode === "guest") {
      router.push("/login");
      return;
    }
    setOwnerHumanCard((prev) => prev && { ...prev, sending: true, error: null });
    try {
      const response =
        sessionStore.viewMode === "human"
          ? await humansApi.sendContactRequest({ peer_id: human.human_id })
          : await api.createContactRequest({ to_human_id: human.human_id });
      const status =
        response && typeof response === "object" && "status" in response
          ? String((response as { status: string }).status)
          : "sent";
      setOwnerHumanCard((prev) => prev && {
        ...prev,
        sending: false,
        status:
          status === "already_contact"
            ? "exists"
            : status === "already_requested"
              ? "pending"
              : "sent",
      });
      await chatStore.refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      const alreadyContact = /already.*contact/i.test(message);
      setOwnerHumanCard((prev) => prev && {
        ...prev,
        sending: false,
        status:
          alreadyContact
            ? "exists"
            : /already.*request|pending/i.test(message)
              ? "pending"
              : prev.status,
        error:
          /already.*contact|already.*request|pending/i.test(message)
            ? null
            : message,
      });
      if (alreadyContact) {
        await chatStore.refreshOverview();
      }
    }
  };

  const mobileShowsMain =
    routeSidebarTab === "contacts"
    || routeSidebarTab === "explore"
    || routeSidebarTab === "wallet"
    || routeSidebarTab === "activity"
    || (routeSidebarTab === "messages" && (uiStore.messagesPane === "user-chat" || Boolean(uiStore.openedRoomId)))
    || (routeSidebarTab === "bots" && Boolean(uiStore.selectedBotAgentId));
  const mobileHideSecondary =
    routeSidebarTab === "wallet"
    || routeSidebarTab === "activity"
    || routeSidebarTab === "explore"
    || routeSidebarTab === "contacts"
    || (routeSidebarTab === "messages" && (uiStore.messagesPane === "user-chat" || Boolean(uiStore.openedRoomId)))
    || (routeSidebarTab === "bots" && Boolean(uiStore.selectedBotAgentId));
  const mainPaneClass = `min-h-0 min-w-0 flex-1 ${mobileShowsMain ? "" : "max-md:hidden"}`;
  const primaryNavigationPending = Boolean(
    uiStore.pendingPrimaryNavigation && pathname !== uiStore.pendingPrimaryNavigation.path,
  );
  const visibleSidebarTab = primaryNavigationPending
    ? uiStore.pendingPrimaryNavigation?.tab ?? uiStore.sidebarTab
    : routeSidebarTab;

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-deep-black max-md:flex-col-reverse">
      <Sidebar
        sidebarTabOverride={visibleSidebarTab}
        mobileHideSecondary={mobileHideSecondary}
        mobileSecondaryOpen={uiStore.mobileSidebarOpen}
        onMobileSecondaryClose={uiStore.closeMobileSidebar}
      />
      <div className={mainPaneClass}>
        {primaryNavigationPending ? (
          <DashboardTabSkeleton variant={visibleSidebarTab} />
        ) : visibleSidebarTab === "home" ? (
          <HomePanel />
        ) : visibleSidebarTab === "activity" ? (
          <ActivityPanel />
        ) : visibleSidebarTab === "wallet" ? (
          <WalletPanel />
        ) : visibleSidebarTab === "bots" ? (
          <MyBotsPanel />
        ) : visibleSidebarTab === "messages" && uiStore.messagesShowRequests ? (
          <ContactRequestsInbox
            title={tChatPane.contactRequests}
            hideTabs
          />
        ) : visibleSidebarTab === "messages" && uiStore.messagesPane === "user-chat" ? (
          <div className="h-full min-w-0">
            <UserChatPane agentId={uiStore.userChatAgentId || userChatAgentIdFromQuery} />
          </div>
        ) : (
          <div className="flex h-full min-w-0">
            <ChatPane
              sidebarTabOverride={
                visibleSidebarTab === "contacts" || visibleSidebarTab === "explore"
                  ? visibleSidebarTab
                  : "messages"
              }
              onHumanOpen={(human) => {
                void handleOpenHumanCard({
                  humanId: human.human_id,
                  displayName: human.display_name,
                });
              }}
            />
            {visibleSidebarTab !== "explore" && uiStore.rightPanelOpen && <AgentBrowser />}
          </div>
        )}
      </div>
      <StripeReturnBanner />
      <BotDetailDrawer />
      <DeviceDetailDrawer />
      <PeerBotDetailDrawer />
      {shouldShowAgentGate ? (
        <AgentGateModal
          onAgentReady={async (agentId) => {
            await sessionStore.refreshUserProfile();
            uiStore.setUserChatAgentId(agentId);
          }}
        />
      ) : null}
      <AgentCardModal
        isOpen={uiStore.agentCardOpen}
        agent={selectedAgentForCard}
        loading={chatStore.selectedAgentLoading}
        error={chatStore.selectedAgentError}
        onClose={() => {
          uiStore.closeAgentCard();
          chatStore.closeAgentCardState();
        }}
        onOwnerOpen={(owner) => {
          void handleOpenHumanCard(owner);
        }}
        alreadyInContacts={alreadyInContacts}
        requestAlreadyPending={requestAlreadyPending}
        sendingFriendRequest={isSendingFriendRequest}
        isOwnAgent={isSelectedAgentOwned}
        onSendFriendRequest={handleSendFriendRequestFromCard}
        onSendMessage={handleSendMessageFromAgentCard}
        onRetry={() => {
          if (!chatStore.selectedAgentId) return;
          void chatStore.selectAgent(chatStore.selectedAgentId);
        }}
      />
      <HumanCardModal
        isOpen={ownerHumanCard !== null}
        human={ownerHumanCard?.human ?? null}
        loading={ownerHumanCard?.loading ?? false}
        error={ownerHumanCard?.error ?? null}
        onClose={() => setOwnerHumanCard(null)}
        isSelf={ownerHumanCard?.human?.human_id === sessionStore.human?.human_id}
        alreadyInContacts={ownerHumanCard?.status === "exists"}
        requestAlreadyPending={ownerHumanCard?.status === "pending"}
        requestSent={ownerHumanCard?.status === "sent"}
        sendingFriendRequest={ownerHumanCard?.sending ?? false}
        onSendFriendRequest={handleSendOwnerHumanFriendRequest}
        onSendMessage={handleSendMessageFromHumanCard}
        onRetry={handleRetryOwnerHumanCard}
      />
    </div>
  );
}
