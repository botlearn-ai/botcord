"use client";

/**
 * [INPUT]: 依赖 useDashboardStore 管理 dashboard 全局状态，依赖 Sidebar/ChatPane/WalletPanel 组织主界面
 * [OUTPUT]: 对外提供 DashboardApp 组件，负责鉴权初始化、请求闸门与三栏布局编排
 * [POS]: /chats 页面的顶层容器，连接路由状态与 UI 面板渲染
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, createContext, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "./Sidebar";
import ChatPane from "./ChatPane";
import AgentBrowser from "./AgentBrowser";
import WalletPanel from "./WalletPanel";
import StripeReturnBanner from "./StripeReturnBanner";
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
  const pathnameParts = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);

  // Auth sync
  useEffect(() => {
    let cancelled = false;

    const resolveSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) {
        return;
      }
      if (session?.access_token) {
        await store.initAuth(session.access_token);
      } else {
        store.setToken(null);
      }
    };

    resolveSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session?.access_token) {
          store.initAuth(session.access_token);
        } else {
          store.setToken(null);
        }
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
  }, [store.authResolved, pathnameParts, store.focusedRoomId, store.openedRoomId, store.overview?.rooms, store.publicRoomDetails, store.publicRooms, store.recentVisitedRooms, store.discoverRooms]);

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
      {store.error && (
        <div className="pointer-events-none absolute right-4 top-4 rounded border border-red-400/40 bg-red-400/10 px-3 py-1.5 text-xs text-red-200">
          {store.error}
        </div>
      )}
    </div>
  );
}
