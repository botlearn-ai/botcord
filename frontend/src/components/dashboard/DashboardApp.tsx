"use client";

import { useEffect, createContext, useContext } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useLanguage } from '@/lib/i18n';
import { dashboardApp } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
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
    switchActiveAgent: store.switchActiveAgent,
    refreshUserProfile: store.refreshUserProfile,
    isGuest: !store.token,
    showLoginModal: () => router.push("/login"),
    handleLogout: store.logout,
  };
}

export default function DashboardApp() {
  const store = useDashboardStore();
  const supabase = createClient();
  const locale = useLanguage();
  const tDash = dashboardApp[locale];
  const tc = common[locale];

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

  // Handle Loading & Error States
  if (store.token && store.loading && !store.overview) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-neon-cyan animate-pulse text-lg">{tc.loading}</div>
      </div>
    );
  }

  if (store.token && store.error && !store.overview) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-400">{store.error}</div>
        <button
          onClick={store.logout}
          className="rounded border border-glass-border px-4 py-2 text-text-secondary hover:text-text-primary"
        >
          {tDash.backToLogin}
        </button>
      </div>
    );
  }

  const showClaimPanel = store.token && store.user && store.ownedAgents.length === 0 && !store.loading;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      {showClaimPanel ? (
        <ClaimAgentPanel onClaimed={store.refreshUserProfile} />
      ) : store.sidebarTab === "wallet" ? (
        <WalletPanel />
      ) : (
        <>
          <ChatPane />
          {store.rightPanelOpen && <AgentBrowser />}
        </>
      )}
      <StripeReturnBanner />
    </div>
  );
}
