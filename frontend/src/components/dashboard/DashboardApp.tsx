"use client";

/**
 * [INPUT]: 依赖 useDashboardStore 管理 dashboard 全局状态，依赖 Sidebar/ChatPane/WalletPanel 组织主界面
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
import WalletPanel from "./WalletPanel";
import StripeReturnBanner from "./StripeReturnBanner";
import AgentGateModal from "./AgentGateModal";
import DashboardShellSkeleton from "./DashboardShellSkeleton";
import { useDashboardStore } from "@/store/useDashboardStore";

// --- Legacy Context Proxy for Compatibility ---
// We keep the context but make it a proxy to the Zustand store 
// so we don't have to refactor all child components at once.

const DashboardContext = createContext<ReturnType<typeof useDashboardStore> | null>(null);

function decodeRoomIdFromPath(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function useDashboard() {
  const store = useDashboardStore();
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.warn("[Dashboard] Supabase signOut failed:", error.message);
    }
    store.logout();
    router.push("/login");
  };
  
  // Add legacy properties/methods that child components expect
  return {
    state: store,
    loadRoomMessages: store.loadRoomMessages,
    loadMoreMessages: store.loadMoreMessages,
    selectAgent: store.selectAgent,
    searchAgents: store.searchAgents,
    refreshOverview: store.refreshOverview,
    loadDiscoverRooms: store.loadDiscoverRooms,
    joinRoom: store.joinRoom,
    loadPublicRooms: store.loadPublicRooms,
    loadPublicRoomDetail: store.loadPublicRoomDetail,
    loadPublicAgents: store.loadPublicAgents,
    loadTopics: store.loadTopics,
    loadWallet: store.loadWallet,
    loadWalletLedger: store.loadWalletLedger,
    loadWithdrawalRequests: store.loadWithdrawalRequests,
    loadContactRequests: store.loadContactRequests,
    sendContactRequest: store.sendContactRequest,
    respondContactRequest: store.respondContactRequest,
    switchActiveAgent: store.switchActiveAgent,
    refreshUserProfile: store.refreshUserProfile,
    sessionMode: store.sessionMode,
    isAuthResolved: store.authResolved,
    isGuest: store.sessionMode === "guest",
    needsAgent: store.sessionMode === "authed-no-agent",
    isAuthedReady: store.sessionMode === "authed-ready",
    showLoginModal: () => router.push("/login"),
    handleLogout,
  };
}

export default function DashboardApp() {
  const store = useDashboardStore();
  const pathname = usePathname();
  const supabase = createClient();
  const recoveredAgentRef = useRef<string | null>(null);
  const initResolvedRef = useRef(false);
  const lastAccessTokenRef = useRef<string | null>(null);
  const pathnameParts = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);
  const shouldShowBootstrapSkeleton =
    !store.authResolved
    || store.authBootstrapping
    || (store.sessionMode === "authed-ready" && !store.overview);
  const fallbackAgent =
    store.ownedAgents.find((agent) => agent.is_default) ?? store.ownedAgents[0] ?? null;
  const shouldShowAgentGate =
    store.authResolved
    && store.sessionMode === "authed-no-agent"
    && store.ownedAgents.length === 0;

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
        if (lastAccessTokenRef.current === accessToken && useDashboardStore.getState().authResolved) {
          return;
        }
        lastAccessTokenRef.current = accessToken;
        await store.initAuth(accessToken);
      } else {
        if (source === "authEvent" && !isSignOutEvent) {
          return;
        }
        lastAccessTokenRef.current = null;
        store.setToken(null);
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
    if (!store.authResolved) {
      return;
    }
    if (store.sessionMode === "authed-no-agent") {
      if (store.focusedRoomId !== null) {
        store.setFocusedRoomId(null);
      }
      if (store.openedRoomId !== null) {
        store.setOpenedRoomId(null);
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
      if (store.sidebarTab !== normalizedTab) {
        store.setSidebarTab(normalizedTab);
      }
      if (tab === "explore" && (subtab === "rooms" || subtab === "agents")) {
        store.setExploreView(subtab);
      }
      if (tab === "contacts" && (subtab === "agents" || subtab === "requests" || subtab === "rooms")) {
        store.setContactsView(subtab);
      }
      if (normalizedTab === "messages") {
        const roomIdFromPath = subtab ? decodeRoomIdFromPath(subtab) : null;
        if (roomIdFromPath) {
          if (store.focusedRoomId !== roomIdFromPath) {
            store.setFocusedRoomId(roomIdFromPath);
          }
          if (store.openedRoomId !== roomIdFromPath) {
            store.setOpenedRoomId(roomIdFromPath);
          }
          const knownRoom =
            Boolean(store.getRoomSummary(roomIdFromPath))
            || store.discoverRooms.some((room) => room.room_id === roomIdFromPath);
          if (!knownRoom) {
            store.loadPublicRoomDetail(roomIdFromPath);
          }
          if (!store.messages[roomIdFromPath]) {
            store.loadRoomMessages(roomIdFromPath);
          }
        } else {
          if (store.focusedRoomId !== null) {
            store.setFocusedRoomId(null);
          }
          if (store.openedRoomId !== null) {
            store.setOpenedRoomId(null);
          }
        }
      }
    } else if (store.sidebarTab !== "messages") {
      store.setSidebarTab("messages");
    }
  }, [store.authResolved, store.sessionMode, pathnameParts]);

  useEffect(() => {
    if (
      !store.authResolved
      || store.sessionMode !== "authed-no-agent"
      || store.activeAgentId
      || !fallbackAgent
    ) {
      if (store.sessionMode !== "authed-no-agent") {
        recoveredAgentRef.current = null;
      }
      return;
    }
    if (recoveredAgentRef.current === fallbackAgent.agent_id) {
      return;
    }
    recoveredAgentRef.current = fallbackAgent.agent_id;
    void store.switchActiveAgent(fallbackAgent.agent_id);
  }, [store.authResolved, store.sessionMode, store.activeAgentId, fallbackAgent, store.switchActiveAgent]);

  if (shouldShowBootstrapSkeleton) {
    return <DashboardShellSkeleton />;
  }

  return (
    <div className="relative flex h-screen overflow-hidden">
      <Sidebar />
      {store.sidebarTab === "wallet" ? (
        <WalletPanel />
      ) : (
        <>
          <ChatPane />
          {store.sidebarTab !== "explore" && store.rightPanelOpen && <AgentBrowser />}
        </>
      )}
      <StripeReturnBanner />
      {shouldShowAgentGate ? (
        <AgentGateModal
          onAgentReady={async (agentId) => {
            await store.refreshUserProfile();
            await store.switchActiveAgent(agentId);
          }}
        />
      ) : null}
      {store.error && (
        <div className="pointer-events-none absolute right-4 top-4 rounded border border-red-400/40 bg-red-400/10 px-3 py-1.5 text-xs text-red-200">
          {store.error}
        </div>
      )}
    </div>
  );
}
