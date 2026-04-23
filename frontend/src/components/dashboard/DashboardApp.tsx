"use client";

/**
 * [INPUT]: 依赖 session/ui/chat/realtime/unread/contact/wallet 多业务 store 聚合 dashboard 状态，依赖 react effect 在后台预热跨 tab 数据与 Supabase Realtime 订阅，依赖 Sidebar/ChatPane/WalletPanel/AgentCardModal 组织主界面
 * [OUTPUT]: 对外提供 DashboardApp 组件，负责鉴权初始化、请求闸门、realtime 生命周期与三栏布局编排
 * [POS]: /chats 页面的顶层容器，连接路由状态、实时事件流与拆分后的 dashboard store
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "nextjs-toploader/app";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import type { RealtimeMetaEvent } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardRealtimeStore } from "@/store/useDashboardRealtimeStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import AgentBrowser from "./AgentBrowser";
import AgentCardModal from "./AgentCardModal";
import AgentGateModal from "./AgentGateModal";
import ChatPane from "./ChatPane";
import DashboardShellSkeleton from "./DashboardShellSkeleton";
import Sidebar from "./Sidebar";
import StripeReturnBanner from "./StripeReturnBanner";
import UserChatPane from "./UserChatPane";
import WalletPanel from "./WalletPanel";
import ActivityPanel from "./ActivityPanel";

const USER_CHAT_SUBTAB = "__user-chat__";

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
  const recoveredAgentRef = useRef<string | null>(null);
  const walletBoundAgentRef = useRef<string | null>(null);
  const contactBoundAgentRef = useRef<string | null>(null);
  const subscriptionBoundAgentRef = useRef<string | null>(null);
  const initResolvedRef = useRef(false);
  const lastAccessTokenRef = useRef<string | null>(null);
  const pathnameParts = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);
  const shouldShowBootstrapSkeleton = !sessionStore.authResolved || sessionStore.authBootstrapping;
  const fallbackAgent =
    sessionStore.ownedAgents.find((agent) => agent.is_default) ?? sessionStore.ownedAgents[0] ?? null;
  // Human-first: never force-block on "no agent". Authed users always proceed
  // into /chats as their Human identity; creating an Agent is a later,
  // optional CTA. AgentGateModal is kept for manual entry points (account
  // menu, etc.) but must never auto-mount.
  const shouldShowAgentGate = false;
  const realtimeTopic = sessionStore.activeAgentId ? `agent:${sessionStore.activeAgentId}` : null;
  const continueTarget = searchParams.get("next");
  const continueHandledRef = useRef<string | null>(null);

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
      session: { access_token?: string } | null,
      source: "getSession" | "authEvent",
      event?: string,
    ) => {
      if (cancelled) return;

      const accessToken = session?.access_token ?? null;
      const isSignOutEvent = event === "SIGNED_OUT";

      if (source === "authEvent" && event === "INITIAL_SESSION") return;
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

    void resolveSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      void syncSession(session, "authEvent", _event);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [sessionStore.initAuth, sessionStore.setToken, supabase]);

  useEffect(() => {
    if (!sessionStore.authResolved) return;

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
        : tab === "messages" || tab === "contacts" || tab === "explore" || tab === "wallet" || tab === "activity" || tab === "user-chat"
          ? tab
          : null;

    if (normalizedTab) {
      const nextSidebarTab = normalizedTab === "user-chat" ? "messages" : normalizedTab;
      if (uiStore.sidebarTab !== nextSidebarTab) uiStore.setSidebarTab(nextSidebarTab);

      if (tab === "explore" && (subtab === "rooms" || subtab === "agents" || subtab === "templates") && uiStore.exploreView !== subtab) {
        uiStore.setExploreView(subtab);
      }

      if (
        tab === "contacts"
        && (subtab === "agents" || subtab === "requests" || subtab === "rooms")
        && uiStore.contactsView !== subtab
      ) {
        uiStore.setContactsView(subtab);
      }

      if (normalizedTab === "messages" || normalizedTab === "user-chat") {
        const opensUserChat = tab === "user-chat" || subtab === USER_CHAT_SUBTAB;
        if (opensUserChat) {
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
    } else if (uiStore.sidebarTab !== "messages") {
      uiStore.setSidebarTab("messages");
    }
  }, [
    sessionStore.authResolved,
    sessionStore.sessionMode,
    pathnameParts,
    uiStore.focusedRoomId,
    uiStore.openedRoomId,
    uiStore.sidebarTab,
    uiStore.messagesPane,
    uiStore.exploreView,
    uiStore.contactsView,
    uiStore.setFocusedRoomId,
    uiStore.setOpenedRoomId,
    uiStore.setSidebarTab,
    uiStore.setMessagesPane,
    uiStore.setExploreView,
    uiStore.setContactsView,
    chatStore.getRoomSummary,
    chatStore.discoverRooms,
    chatStore.messages,
    chatStore.loadPublicRoomDetail,
    chatStore.loadRoomMessages,
    chatStore.pollNewMessages,
  ]);

  useEffect(() => {
    if (
      !sessionStore.authResolved
      || sessionStore.sessionMode !== "authed-no-agent"
      || sessionStore.activeAgentId
      || !fallbackAgent
    ) {
      if (sessionStore.sessionMode !== "authed-no-agent") {
        recoveredAgentRef.current = null;
      }
      return;
    }
    if (recoveredAgentRef.current === fallbackAgent.agent_id) return;
    recoveredAgentRef.current = fallbackAgent.agent_id;
    void chatStore.switchActiveAgent(fallbackAgent.agent_id);
  }, [
    sessionStore.authResolved,
    sessionStore.sessionMode,
    sessionStore.activeAgentId,
    fallbackAgent,
    chatStore.switchActiveAgent,
  ]);

  useEffect(() => {
    if (sessionStore.sessionMode !== "authed-ready" || !sessionStore.activeAgentId) {
      walletBoundAgentRef.current = null;
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

    if (chatStore.boundAgentId !== sessionStore.activeAgentId) {
      chatStore.bindToActiveAgent(sessionStore.activeAgentId);
    }

    if (walletBoundAgentRef.current !== sessionStore.activeAgentId) {
      walletBoundAgentRef.current = sessionStore.activeAgentId;
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
    if (!chatStore.overview && !chatStore.overviewRefreshing && uiStore.sidebarTab !== "wallet") {
      void chatStore.refreshOverview();
    }
  }, [
    sessionStore.sessionMode,
    sessionStore.activeAgentId,
    uiStore.sidebarTab,
    chatStore.boundAgentId,
    chatStore.bindToActiveAgent,
    uiStore.resetUIState,
    chatStore.overview,
    chatStore.overviewRefreshing,
    chatStore.resetChatState,
    chatStore.refreshOverview,
    unreadStore.resetUnreadState,
    realtimeStore.resetRealtimeState,
    walletStore.resetWalletState,
    contactStore.resetContactState,
    subscriptionStore.resetSubscriptionState,
  ]);

  useEffect(() => {
    if (!sessionStore.authResolved || sessionStore.sessionMode !== "authed-ready") return;
    if (uiStore.sidebarTab === "wallet" || uiStore.sidebarTab === "activity") return;
    if (chatStore.overview || chatStore.overviewRefreshing) return;
    void chatStore.refreshOverview();
  }, [
    sessionStore.authResolved,
    sessionStore.sessionMode,
    uiStore.sidebarTab,
    chatStore.overview,
    chatStore.overviewRefreshing,
    chatStore.refreshOverview,
  ]);

  // Eagerly register userChatRoomId so realtime events are always routed to the user-chat pane
  useEffect(() => {
    if (sessionStore.sessionMode !== "authed-ready" || !sessionStore.activeAgentId) return;

    let cancelled = false;
    api.getUserChatRoom().then((room) => {
      if (!cancelled) uiStore.setUserChatRoomId(room.room_id);
    }).catch(() => { /* ignore — UserChatPane will retry on mount */ });

    return () => { cancelled = true; };
  }, [sessionStore.sessionMode, sessionStore.activeAgentId, uiStore.setUserChatRoomId]);

  useEffect(() => {
    if (
      !sessionStore.authResolved
      || sessionStore.sessionMode !== "authed-ready"
      || !sessionStore.activeAgentId
    ) {
      realtimeStore.setRealtimeStatus("idle");
      return;
    }

    const topic = `agent:${sessionStore.activeAgentId}`;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const subscribeRealtime = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      if (!accessToken) {
        console.warn("[BotCord][Realtime] missing access token before subscribe", {
          topic,
          activeAgentId: sessionStore.activeAgentId,
        });
        realtimeStore.setRealtimeStatus("error", "realtime missing access token");
        return;
      }

      await supabase.realtime.setAuth(accessToken);
      if (cancelled) return;

      realtimeStore.setRealtimeStatus("connecting");
      console.info("[BotCord][Realtime] subscribing", {
        topic,
        activeAgentId: sessionStore.activeAgentId,
        sessionMode: sessionStore.sessionMode,
      });

      channel = supabase
        .channel(topic, { config: { private: true } })
        .on("broadcast", { event: "*" }, ({ payload }) => {
          const realtimeEvent = payload as RealtimeMetaEvent;
          if (!realtimeEvent?.type || realtimeEvent.agent_id !== sessionStore.activeAgentId) {
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
          chatStore.applyRealtimeEventHint(realtimeEvent);
          if (!isOpenedRoomEvent) {
            unreadStore.applyRealtimeEvent(realtimeEvent);
          }
          void realtimeStore.syncRealtimeEvent(realtimeEvent);
        })
        .subscribe((status) => {
          console.info("[BotCord][Realtime] channel status", {
            topic,
            status,
          });
          if (status === "SUBSCRIBED") {
            realtimeStore.setRealtimeStatus("connected");
            return;
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            realtimeStore.setRealtimeStatus("error", `realtime ${status.toLowerCase()}`);
          }
        });
    };

    void subscribeRealtime();

    return () => {
      cancelled = true;
      console.info("[BotCord][Realtime] removing channel", {
        topic,
      });
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [
    sessionStore.authResolved,
    sessionStore.sessionMode,
    sessionStore.activeAgentId,
    chatStore.applyRealtimeEventHint,
    unreadStore.applyRealtimeEvent,
    realtimeStore.setRealtimeStatus,
    realtimeStore.syncRealtimeEvent,
    supabase,
  ]);

  useEffect(() => {
    if (!sessionStore.authResolved) return;

    if (chatStore.publicRooms.length === 0 && !chatStore.publicRoomsLoading) {
      void chatStore.loadPublicRooms();
    }
    if (chatStore.publicAgents.length === 0 && !chatStore.publicAgentsLoading) {
      void chatStore.loadPublicAgents();
    }
  }, [
    sessionStore.authResolved,
    chatStore.publicRooms.length,
    chatStore.publicRoomsLoading,
    chatStore.publicAgents.length,
    chatStore.publicAgentsLoading,
    chatStore.loadPublicRooms,
    chatStore.loadPublicAgents,
  ]);

  useEffect(() => {
    if (sessionStore.sessionMode !== "authed-ready" || !sessionStore.activeAgentId) return;

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
    sessionStore.activeAgentId,
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

  if (shouldShowBootstrapSkeleton) {
    return <DashboardShellSkeleton />;
  }

  const selectedAgentForCard = chatStore.selectedAgentProfile;
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
    if (sessionStore.sessionMode !== "authed-ready") {
      router.push("/login");
      return;
    }
    void contactStore.sendContactRequest(selectedAgentForCard.agent_id);
  };

  return (
    <div className="relative flex h-screen overflow-hidden">
      <Sidebar />
      {uiStore.sidebarTab === "activity" ? (
        <ActivityPanel />
      ) : uiStore.sidebarTab === "wallet" ? (
        <WalletPanel />
      ) : uiStore.sidebarTab === "messages" && uiStore.messagesPane === "user-chat" ? (
        <div className="flex-1 min-w-0">
          <UserChatPane />
        </div>
      ) : (
        <>
          <ChatPane />
          {uiStore.sidebarTab !== "explore" && uiStore.rightPanelOpen && <AgentBrowser />}
        </>
      )}
      <StripeReturnBanner />
      {shouldShowAgentGate ? (
        <AgentGateModal
          onAgentReady={async (agentId) => {
            await sessionStore.refreshUserProfile();
            await chatStore.switchActiveAgent(agentId);
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
        alreadyInContacts={alreadyInContacts}
        requestAlreadyPending={requestAlreadyPending}
        sendingFriendRequest={isSendingFriendRequest}
        onSendFriendRequest={handleSendFriendRequestFromCard}
        onRetry={() => {
          if (!chatStore.selectedAgentId) return;
          void chatStore.selectAgent(chatStore.selectedAgentId);
        }}
      />
      {chatStore.error && (
        <div className="pointer-events-none absolute right-4 top-4 rounded border border-red-400/40 bg-red-400/10 px-3 py-1.5 text-xs text-red-200">
          {chatStore.error}
        </div>
      )}
    </div>
  );
}
