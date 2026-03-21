"use client";

/**
 * [INPUT]: 依赖 session/channel/contact/wallet 多业务 store 聚合 dashboard 状态，依赖 react effect 在后台预热跨 tab 数据，依赖 Sidebar/ChatPane/WalletPanel/AgentCardModal 组织主界面
 * [OUTPUT]: 对外提供 DashboardApp 组件，负责鉴权初始化、请求闸门与三栏布局编排
 * [POS]: /chats 页面的顶层容器，连接路由状态与 UI 面板渲染
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, createContext, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePathname } from "next/navigation";
import { useRouter } from "nextjs-toploader/app";
import Sidebar from "./Sidebar";
import ChatPane from "./ChatPane";
import AgentBrowser from "./AgentBrowser";
import AgentCardModal from "./AgentCardModal";
import WalletPanel from "./WalletPanel";
import StripeReturnBanner from "./StripeReturnBanner";
import AgentGateModal from "./AgentGateModal";
import DashboardShellSkeleton from "./DashboardShellSkeleton";
import { useDashboardChannelStore } from "@/store/useDashboardChannelStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

// --- Legacy Context Proxy for Compatibility ---
// We keep the context but make it a proxy to the Zustand store 
// so we don't have to refactor all child components at once.

const DashboardContext = createContext<ReturnType<typeof useDashboardSessionStore> | null>(null);

function decodeRoomIdFromPath(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function useDashboard() {
  const sessionStore = useDashboardSessionStore();
  const channelStore = useDashboardChannelStore();
  const walletStore = useDashboardWalletStore();
  const contactStore = useDashboardContactStore();
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.warn("[Dashboard] Supabase signOut failed:", error.message);
    }
    sessionStore.logout();
    channelStore.logout();
    walletStore.resetWalletState();
    contactStore.resetContactState();
    router.push("/login");
  };
  
  // Add legacy properties/methods that child components expect
  const state = { ...channelStore, ...contactStore, ...walletStore, ...sessionStore };
  return {
    state,
    loadRoomMessages: channelStore.loadRoomMessages,
    loadMoreMessages: channelStore.loadMoreMessages,
    pollNewMessages: channelStore.pollNewMessages,
    selectAgent: channelStore.selectAgent,
    searchAgents: channelStore.searchAgents,
    refreshOverview: channelStore.refreshOverview,
    loadDiscoverRooms: channelStore.loadDiscoverRooms,
    joinRoom: channelStore.joinRoom,
    loadPublicRooms: channelStore.loadPublicRooms,
    loadPublicRoomDetail: channelStore.loadPublicRoomDetail,
    loadPublicAgents: channelStore.loadPublicAgents,
    loadWallet: walletStore.loadWallet,
    loadWalletLedger: walletStore.loadWalletLedger,
    loadWithdrawalRequests: walletStore.loadWithdrawalRequests,
    loadContactRequests: contactStore.loadContactRequests,
    sendContactRequest: contactStore.sendContactRequest,
    respondContactRequest: contactStore.respondContactRequest,
    switchActiveAgent: channelStore.switchActiveAgent,
    refreshUserProfile: sessionStore.refreshUserProfile,
    sessionMode: sessionStore.sessionMode,
    isAuthResolved: sessionStore.authResolved,
    isGuest: sessionStore.sessionMode === "guest",
    needsAgent: sessionStore.sessionMode === "authed-no-agent",
    isAuthedReady: sessionStore.sessionMode === "authed-ready",
    showLoginModal: () => router.push("/login"),
    handleLogout,
  };
}

export default function DashboardApp() {
  const sessionStore = useDashboardSessionStore();
  const channelStore = useDashboardChannelStore();
  const walletStore = useDashboardWalletStore();
  const contactStore = useDashboardContactStore();
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const recoveredAgentRef = useRef<string | null>(null);
  const walletBoundAgentRef = useRef<string | null>(null);
  const contactBoundAgentRef = useRef<string | null>(null);
  const initResolvedRef = useRef(false);
  const lastAccessTokenRef = useRef<string | null>(null);
  const pathnameParts = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);
  const shouldShowBootstrapSkeleton =
    !sessionStore.authResolved
    || sessionStore.authBootstrapping;
  const fallbackAgent =
    sessionStore.ownedAgents.find((agent) => agent.is_default) ?? sessionStore.ownedAgents[0] ?? null;
  const shouldShowAgentGate =
    sessionStore.authResolved
    && sessionStore.sessionMode === "authed-no-agent"
    && sessionStore.ownedAgents.length === 0;

  // Auth sync
  useEffect(() => {
    let cancelled = false;

    const syncSession = async (
      session: { access_token?: string } | null,
      source: "getSession" | "authEvent",
      event?: string,
    ) => {
      if (cancelled) {
        return;
      }

      const accessToken = session?.access_token ?? null;
      const isSignOutEvent = event === "SIGNED_OUT";

      if (source === "authEvent" && event === "INITIAL_SESSION") {
        return;
      }

      if (source === "authEvent" && !initResolvedRef.current && !accessToken && !isSignOutEvent) {
        return;
      }

      if (accessToken) {
        if (lastAccessTokenRef.current === accessToken && useDashboardSessionStore.getState().authResolved) {
          return;
        }
        lastAccessTokenRef.current = accessToken;
        await sessionStore.initAuth(accessToken);
      } else {
        if (source === "authEvent" && !isSignOutEvent) {
          return;
        }
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

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        void syncSession(session, "authEvent", _event);
      },
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  // Route sync: /chats/{tab}/{subtab?}
  useEffect(() => {
    if (!sessionStore.authResolved) {
      return;
    }
    if (sessionStore.sessionMode === "authed-no-agent") {
      if (channelStore.focusedRoomId !== null) {
        channelStore.setFocusedRoomId(null);
      }
      if (channelStore.openedRoomId !== null) {
        channelStore.setOpenedRoomId(null);
      }
      return;
    }
    const parts = pathnameParts;
    // ["chats", tab?, subtab?]
    const tab = parts[1];
    const subtab = parts[2];
    const normalizedTab =
      tab === "dm" || tab === "rooms"
        ? "messages"
        : tab === "messages" || tab === "contacts" || tab === "explore" || tab === "wallet"
          ? tab
          : null;
    if (normalizedTab) {
      if (channelStore.sidebarTab !== normalizedTab) {
        channelStore.setSidebarTab(normalizedTab);
      }
      if (tab === "explore" && (subtab === "rooms" || subtab === "agents")) {
        if (channelStore.exploreView !== subtab) {
          channelStore.setExploreView(subtab);
        }
      }
      if (tab === "contacts" && (subtab === "agents" || subtab === "requests" || subtab === "rooms")) {
        if (channelStore.contactsView !== subtab) {
          channelStore.setContactsView(subtab);
        }
      }
      if (normalizedTab === "messages") {
        const roomIdFromPath = subtab ? decodeRoomIdFromPath(subtab) : null;
        if (roomIdFromPath) {
          if (channelStore.focusedRoomId !== roomIdFromPath) {
            channelStore.setFocusedRoomId(roomIdFromPath);
          }
          if (channelStore.openedRoomId !== roomIdFromPath) {
            channelStore.setOpenedRoomId(roomIdFromPath);
          }
          const knownRoom =
            Boolean(channelStore.getRoomSummary(roomIdFromPath))
            || channelStore.discoverRooms.some((room) => room.room_id === roomIdFromPath);
          if (!knownRoom) {
            channelStore.loadPublicRoomDetail(roomIdFromPath);
          }
          if (!channelStore.messages[roomIdFromPath]) {
            channelStore.loadRoomMessages(roomIdFromPath);
          }
        } else {
          if (channelStore.focusedRoomId !== null) {
            channelStore.setFocusedRoomId(null);
          }
          if (channelStore.openedRoomId !== null) {
            channelStore.setOpenedRoomId(null);
          }
        }
      }
    } else if (channelStore.sidebarTab !== "messages") {
      channelStore.setSidebarTab("messages");
    }
  }, [sessionStore.authResolved, sessionStore.sessionMode, pathnameParts, channelStore]);

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
    if (recoveredAgentRef.current === fallbackAgent.agent_id) {
      return;
    }
    recoveredAgentRef.current = fallbackAgent.agent_id;
    void channelStore.switchActiveAgent(fallbackAgent.agent_id);
  }, [sessionStore.authResolved, sessionStore.sessionMode, sessionStore.activeAgentId, fallbackAgent, channelStore.switchActiveAgent]);

  useEffect(() => {
    if (sessionStore.sessionMode !== "authed-ready" || !sessionStore.activeAgentId) {
      walletBoundAgentRef.current = null;
      contactBoundAgentRef.current = null;
      channelStore.resetChannelState();
      walletStore.resetWalletState();
      contactStore.resetContactState();
      return;
    }
    if (walletBoundAgentRef.current !== sessionStore.activeAgentId) {
      walletBoundAgentRef.current = sessionStore.activeAgentId;
      walletStore.resetWalletState();
    }
    if (contactBoundAgentRef.current !== sessionStore.activeAgentId) {
      contactBoundAgentRef.current = sessionStore.activeAgentId;
      contactStore.resetContactState();
    }
    if (!channelStore.overview && !channelStore.overviewRefreshing && channelStore.sidebarTab !== "wallet") {
      void channelStore.refreshOverview();
    }
  }, [
    sessionStore.sessionMode,
    sessionStore.activeAgentId,
    channelStore.overview,
    channelStore.overviewRefreshing,
    channelStore.sidebarTab,
    channelStore.resetChannelState,
    channelStore.refreshOverview,
    walletStore.resetWalletState,
    contactStore.resetContactState,
  ]);

  useEffect(() => {
    if (!sessionStore.authResolved || sessionStore.sessionMode !== "authed-ready") {
      return;
    }
    if (channelStore.sidebarTab === "wallet") {
      return;
    }
    if (channelStore.overview || channelStore.overviewRefreshing) {
      return;
    }
    void channelStore.refreshOverview();
  }, [
    sessionStore.authResolved,
    sessionStore.sessionMode,
    channelStore.sidebarTab,
    channelStore.overview,
    channelStore.overviewRefreshing,
    channelStore.refreshOverview,
  ]);

  useEffect(() => {
    if (!sessionStore.authResolved) {
      return;
    }

    if (channelStore.publicRooms.length === 0 && !channelStore.publicRoomsLoading) {
      void channelStore.loadPublicRooms();
    }

    if (channelStore.publicAgents.length === 0 && !channelStore.publicAgentsLoading) {
      void channelStore.loadPublicAgents();
    }
  }, [
    sessionStore.authResolved,
    channelStore.publicRooms.length,
    channelStore.publicRoomsLoading,
    channelStore.publicAgents.length,
    channelStore.publicAgentsLoading,
    channelStore.loadPublicRooms,
    channelStore.loadPublicAgents,
  ]);

  useEffect(() => {
    if (sessionStore.sessionMode !== "authed-ready" || !sessionStore.activeAgentId) {
      return;
    }

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

  if (shouldShowBootstrapSkeleton) {
    return <DashboardShellSkeleton />;
  }

  const selectedAgentForCard = channelStore.selectedAgentProfile;
  const alreadyInContacts = selectedAgentForCard
    ? (channelStore.overview?.contacts || []).some(
      (item) => item.contact_agent_id === selectedAgentForCard.agent_id,
    )
    : false;
  const requestAlreadyPending = selectedAgentForCard
    ? contactStore.pendingFriendRequests.includes(selectedAgentForCard.agent_id)
      || contactStore.contactRequestsSent.some(
        (item) => item.to_agent_id === selectedAgentForCard.agent_id && item.state === "pending",
      )
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
      {channelStore.sidebarTab === "wallet" ? (
        <WalletPanel />
      ) : (
        <>
          <ChatPane />
          {channelStore.sidebarTab !== "explore" && channelStore.rightPanelOpen && <AgentBrowser />}
        </>
      )}
      <StripeReturnBanner />
      {shouldShowAgentGate ? (
        <AgentGateModal
          onAgentReady={async (agentId) => {
            await sessionStore.refreshUserProfile();
            await channelStore.switchActiveAgent(agentId);
          }}
        />
      ) : null}
      <AgentCardModal
        isOpen={channelStore.agentCardOpen}
        agent={selectedAgentForCard}
        loading={channelStore.selectedAgentLoading}
        error={channelStore.selectedAgentError}
        onClose={channelStore.closeAgentCard}
        alreadyInContacts={alreadyInContacts}
        requestAlreadyPending={requestAlreadyPending}
        onSendFriendRequest={handleSendFriendRequestFromCard}
        onRetry={() => {
          if (!channelStore.selectedAgentId) return;
          void channelStore.selectAgent(channelStore.selectedAgentId);
        }}
      />
      {channelStore.error && (
        <div className="pointer-events-none absolute right-4 top-4 rounded border border-red-400/40 bg-red-400/10 px-3 py-1.5 text-xs text-red-200">
          {channelStore.error}
        </div>
      )}
    </div>
  );
}
