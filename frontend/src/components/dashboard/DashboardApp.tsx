"use client";

import { useEffect, createContext, useContext } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "./Sidebar";
import ChatPane from "./ChatPane";
import AgentBrowser from "./AgentBrowser";
import WalletPanel from "./WalletPanel";
import StripeReturnBanner from "./StripeReturnBanner";
import ClaimAgentPanel from "./ClaimAgentPanel";
import { useDashboardStore } from "@/store/useDashboardStore";

// --- Legacy Context Proxy for Compatibility ---
// We keep the context but make it a proxy to the Zustand store 
// so we don't have to refactor all child components at once.

const DashboardContext = createContext<ReturnType<typeof useDashboardStore> | null>(null);

export function useDashboard() {
  const store = useDashboardStore();
  const router = useRouter();
  
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
    loadContactRequests: store.loadContactRequests,
    sendContactRequest: store.sendContactRequest,
    respondContactRequest: store.respondContactRequest,
    switchActiveAgent: store.switchActiveAgent,
    refreshUserProfile: store.refreshUserProfile,
    isGuest: !store.token,
    showLoginModal: () => router.push("/login"),
    handleLogout: store.logout,
  };
}

export default function DashboardApp() {
  const store = useDashboardStore();
  const pathname = usePathname();
  const supabase = createClient();

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
    if (!store.token) {
      store.loadPublicRooms();
      store.loadPublicAgents();
    }
  }, [store.token]);

  // Route sync: /chats/{tab}/{subtab?}
  useEffect(() => {
    const parts = pathname.split("/").filter(Boolean);
    // ["chats", tab?, subtab?]
    const tab = parts[1];
    const subtab = parts[2];
    if (tab === "dm" || tab === "rooms" || tab === "contacts" || tab === "explore" || tab === "wallet") {
      if (store.sidebarTab !== tab) {
        store.setSidebarTab(tab);
      }
      if (tab === "explore" && (subtab === "rooms" || subtab === "agents")) {
        store.setExploreView(subtab);
      }
      if (tab === "contacts" && (subtab === "agents" || subtab === "requests")) {
        store.setContactsView(subtab);
      }
    } else if (store.sidebarTab !== "explore") {
      store.setSidebarTab("explore");
    }
  }, [pathname]);

  const showClaimPanel = store.token && store.user && store.ownedAgents.length === 0 && !store.loading;

  return (
    <div className="relative flex h-screen overflow-hidden">
      <Sidebar />
      {showClaimPanel ? (
        <ClaimAgentPanel onClaimed={store.refreshUserProfile} />
      ) : store.sidebarTab === "wallet" ? (
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
