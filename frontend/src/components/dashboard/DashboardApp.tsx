"use client";

/**
 * [INPUT]: 依赖 useDashboardStore 管理 dashboard 全局状态，依赖 Sidebar/ChatPane/WalletPanel 组织主界面
 * [OUTPUT]: 对外提供 DashboardApp 组件，负责鉴权初始化与三栏布局编排
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
  const router = useRouter();
  const supabase = createClient();
  const pathnameParts = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);

  // Auth sync
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.access_token) {
        store.initAuth(session.access_token);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session?.access_token) {
          store.initAuth(session.access_token);
        } else {
          store.setToken(null);
        }
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  // Guest mode initial load
  useEffect(() => {
    if (store.sessionMode === "guest") {
      store.loadPublicRooms();
      store.loadPublicAgents();
    }
  }, [store.sessionMode]);

  // Route sync: /chats/{tab}/{subtab?}
  useEffect(() => {
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
          if (store.selectedRoomId !== roomIdFromPath) {
            store.setSelectedRoomId(roomIdFromPath);
          }
          if (!store.messages[roomIdFromPath]) {
            store.loadRoomMessages(roomIdFromPath);
          }
        }
      }
    } else if (store.sidebarTab !== "messages") {
      store.setSidebarTab("messages");
    }
  }, [pathnameParts, store.selectedRoomId]);

  // Default focus for message list: if messages tab has room candidates but no selected room,
  // pick the first one and sync URL for precise location.
  useEffect(() => {
    if (store.sidebarTab !== "messages" || store.selectedRoomId) {
      return;
    }
    const joinedRooms = store.overview?.rooms || [];
    const joinedRoomIds = new Set(joinedRooms.map((room) => room.room_id));
    const recentUnjoinedRooms = store.recentVisitedRooms.filter((room) => !joinedRoomIds.has(room.room_id));
    const mergedRooms = [...joinedRooms, ...recentUnjoinedRooms].sort((a, b) => {
      const aTs = a.last_message_at ? Date.parse(a.last_message_at) : 0;
      const bTs = b.last_message_at ? Date.parse(b.last_message_at) : 0;
      return bTs - aTs;
    });
    const candidateRoomId = (store.token ? mergedRooms : store.recentVisitedRooms)[0]?.room_id;
    if (!candidateRoomId) {
      return;
    }
    store.setSelectedRoomId(candidateRoomId);
    const nextPath = `/chats/messages/${encodeURIComponent(candidateRoomId)}`;
    if (pathname !== nextPath) {
      router.replace(nextPath);
    }
    if (!store.messages[candidateRoomId]) {
      store.loadRoomMessages(candidateRoomId);
    }
  }, [
    store.sidebarTab,
    store.selectedRoomId,
    store.token,
    store.overview?.rooms,
    store.recentVisitedRooms,
    store.messages,
    pathname,
    router,
  ]);

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
