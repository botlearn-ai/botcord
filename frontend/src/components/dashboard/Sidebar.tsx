"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { sidebar } from '@/lib/i18n/translations/dashboard';
import { common, nav } from '@/lib/i18n/translations/common';
import RoomList from "./RoomList";
import AgentSwitcher from "./AgentSwitcher";

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const authNavItems = [
  {
    key: "dm" as const,
    label: "Direct Message",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
      </svg>
    ),
  },
  {
    key: "rooms" as const,
    label: "Rooms",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.732-3.558" />
      </svg>
    ),
  },
  {
    key: "contacts" as const,
    label: "Contacts",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
      </svg>
    ),
  },
  {
    key: "explore" as const,
    label: "Explore",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607Z" />
      </svg>
    ),
  },
  {
    key: "wallet" as const,
    label: "Wallet",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
      </svg>
    ),
  },
] as const;

const guestNavItems = [
  {
    key: "explore" as const,
    label: "Explore",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607Z" />
      </svg>
    ),
  },
  {
    key: "rooms" as const,
    label: "Rooms",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.732-3.558" />
      </svg>
    ),
  },
  {
    key: "wallet" as const,
    label: "Wallet",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
      </svg>
    ),
  },
] as const;

export default function Sidebar() {
  const { state, refreshOverview, switchActiveAgent, loadRoomMessages, isGuest, showLoginModal, handleLogout } = useDashboard();
  const router = useRouter();
  const locale = useLanguage();
  const t = sidebar[locale];
  const tc = common[locale];
  const tNav = nav[locale];

  const tabTitles: Record<string, string> = {
    dm: t.directMessage,
    rooms: t.rooms,
    contacts: t.contacts,
    explore: t.discover,
    wallet: t.wallet,
  };

  const navItems = isGuest ? guestNavItems : authNavItems;

  const dmRooms = state.overview?.rooms.filter(r => r.room_id.startsWith("rm_dm_")) || [];
  const groupRooms = state.overview?.rooms.filter(r => !r.room_id.startsWith("rm_dm_")) || [];
  const recentGuestRooms = state.recentVisitedRooms;

  const openRecentGuestRoom = (roomId: string) => {
    state.setSelectedRoomId(roomId);
    router.push("/chats/rooms");
    if (!state.messages[roomId]) {
      loadRoomMessages(roomId);
    }
  };

  const navigatePrimaryTab = (tab: "dm" | "rooms" | "contacts" | "explore" | "wallet") => {
    const pathByTab: Record<typeof tab, string> = {
      dm: "/chats/dm",
      rooms: "/chats/rooms",
      contacts: `/chats/contacts/${state.contactsView}`,
      explore: `/chats/explore/${state.exploreView}`,
      wallet: "/chats/wallet",
    };
    state.setSidebarTab(tab);
    router.push(pathByTab[tab]);
  };

  return (
    <div className="flex h-full">
      {/* Primary rail */}
      <div className="flex h-full w-16 min-w-[64px] flex-col items-center border-r border-glass-border bg-deep-black py-3">
        <Link
          href="/"
          className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-glass-border bg-deep-black-light transition-colors hover:border-neon-cyan/50 hover:bg-glass-bg"
          title={tNav.home}
        >
          <img src="/logo.svg" alt="BotCord" className="h-6 w-6" />
        </Link>
        {/* Nav icons */}
        <div className="flex flex-1 flex-col items-center gap-1 pt-1">
          {navItems.map((item) => {
            const isActive = state.sidebarTab === item.key;
            const isExplore = item.key === "explore";
            return (
              <button
                key={item.key}
                onClick={() => navigatePrimaryTab(item.key)}
                className={`group relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition-all duration-200 ${
                  isActive
                    ? isExplore
                      ? "bg-neon-purple/15 text-neon-purple"
                      : "bg-neon-cyan/15 text-neon-cyan"
                    : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                }`}
                title={tabTitles[item.key] || item.label}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <div className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full ${isExplore ? "bg-neon-purple" : "bg-neon-cyan"}`} />
                )}
                {item.icon}
                <span className="mt-0.5 text-[9px] font-medium leading-none">{tabTitles[item.key] || item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Bottom: user avatar + actions */}
        <div className="flex flex-col items-center gap-2 border-t border-glass-border pt-3">
          {isGuest ? (
            /* Guest: Login button */
            <button
              onClick={showLoginModal}
              className="flex h-10 w-12 flex-col items-center justify-center rounded-xl text-neon-cyan transition-all duration-200 hover:bg-neon-cyan/10"
              title={tc.login}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m-6 0 3 3m0 0 3-3m-3 3V9" />
              </svg>
              <span className="mt-0.5 text-[9px] font-medium leading-none">{tc.login}</span>
            </button>
          ) : (
            <>
              {/* Pending requests indicator */}
              {state.overview && state.overview.pending_requests > 0 && (
                <div className="relative" title={`${state.overview.pending_requests} pending requests`}>
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neon-purple/20 text-[10px] font-bold text-neon-purple">
                    {state.overview.pending_requests}
                  </div>
                </div>
              )}
              <button
                onClick={refreshOverview}
                disabled={state.loading}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-glass-bg hover:text-neon-cyan disabled:opacity-40"
                title={tc.refresh}
              >
                <span className={`text-sm ${state.loading ? "inline-block animate-spin" : ""}`}>&#x21BB;</span>
              </button>
              <button
                onClick={handleLogout}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-glass-bg hover:text-red-400"
                title={tc.logout}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Secondary panel */}
      <div className="flex h-full w-[260px] min-w-[260px] flex-col border-r border-glass-border bg-deep-black-light">
        {/* Agent switcher (auth mode with agents) */}
        {!isGuest && state.ownedAgents.length > 0 && (
          <div className="border-b border-glass-border px-3 py-2">
            <AgentSwitcher
              agents={state.ownedAgents}
              activeAgentId={state.activeAgentId}
              onSwitch={switchActiveAgent}
            />
          </div>
        )}

        {/* Panel header */}
        <div className="flex items-center justify-between border-b border-glass-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {tabTitles[state.sidebarTab]}
            </h2>
            {isGuest && (
              <p className="truncate text-[10px] text-text-secondary/60">
                {t.browseAsGuest}
              </p>
            )}
          </div>
        </div>

        {/* Secondary navigation */}
        {state.sidebarTab === "explore" && (
          <div className="border-b border-glass-border p-3">
            <button
              onClick={() => {
                state.setExploreView("rooms");
                router.push("/chats/explore/rooms");
              }}
              className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                state.exploreView === "rooms"
                  ? "border-neon-purple/60 bg-neon-purple/10 text-neon-purple"
                  : "border-glass-border text-text-secondary hover:text-text-primary"
              }`}
            >
              Public Rooms
            </button>
            <button
              onClick={() => {
                state.setExploreView("agents");
                router.push("/chats/explore/agents");
              }}
              className={`mt-2 w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                state.exploreView === "agents"
                  ? "border-neon-purple/60 bg-neon-purple/10 text-neon-purple"
                  : "border-glass-border text-text-secondary hover:text-text-primary"
              }`}
            >
              Agents
            </button>
          </div>
        )}

        {state.sidebarTab === "contacts" && (
          <div className="border-b border-glass-border p-3">
            <button
              onClick={() => {
                state.setContactsView("agents");
                router.push("/chats/contacts/agents");
              }}
              className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                state.contactsView === "agents"
                  ? "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan"
                  : "border-glass-border text-text-secondary hover:text-text-primary"
              }`}
            >
              Agents
            </button>
            <button
              onClick={() => {
                state.setContactsView("requests");
                router.push("/chats/contacts/requests");
              }}
              className={`mt-2 w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                state.contactsView === "requests"
                  ? "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan"
                  : "border-glass-border text-text-secondary hover:text-text-primary"
              }`}
            >
              Requests
            </button>
          </div>
        )}

        {/* Panel content */}
        <div className="flex-1 overflow-y-auto">
          {state.sidebarTab === "dm" && (
            <div className="py-1">
              {dmRooms.length === 0 ? (
                <p className="p-4 text-center text-xs text-text-secondary">{t.noDirectMessages}</p>
              ) : (
                <RoomList rooms={dmRooms} />
              )}
            </div>
          )}

          {state.sidebarTab === "rooms" && (
            <div className="py-1">
              {isGuest ? (
                recentGuestRooms.length === 0 ? (
                  <p className="p-4 text-center text-xs text-text-secondary">No recent rooms yet</p>
                ) : (
                  recentGuestRooms.map((room) => {
                    const isSelected = state.selectedRoomId === room.room_id;
                    return (
                      <button
                        key={room.room_id}
                        onClick={() => openRecentGuestRoom(room.room_id)}
                        className={`w-full border-l-2 px-4 py-2.5 text-left transition-colors ${
                          isSelected
                            ? "border-neon-cyan bg-neon-cyan/10"
                            : "border-transparent hover:bg-glass-bg"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className={`truncate text-sm font-medium ${isSelected ? "text-neon-cyan" : "text-text-primary"}`}>
                            {room.name}
                          </span>
                          <span className="ml-2 shrink-0 text-xs text-text-secondary">
                            {room.member_count}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary/50">
                          {room.room_id}
                        </p>
                        {room.description && (
                          <p className="mt-0.5 truncate text-xs text-text-secondary">
                            {room.description}
                          </p>
                        )}
                      </button>
                    );
                  })
                )
              ) : (
                <RoomList rooms={groupRooms} />
              )}
            </div>
          )}

          {state.sidebarTab === "wallet" && (
            <div className="p-4">
              {isGuest ? (
                <div className="rounded-xl border border-glass-border bg-glass-bg p-6 text-center">
                  <div className="mb-4 flex justify-center text-neon-cyan">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-12 w-12">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
                    </svg>
                  </div>
                  <h3 className="mb-2 text-sm font-semibold text-text-primary">Wallet Support</h3>
                  <p className="mb-6 text-xs text-text-secondary leading-relaxed">
                    Log in to access your wallet, manage balances, and perform transactions.
                  </p>
                  <button
                    onClick={showLoginModal}
                    className="w-full rounded-lg bg-neon-cyan/10 py-2.5 text-xs font-semibold text-neon-cyan transition-all hover:bg-neon-cyan/20 border border-neon-cyan/20"
                  >
                    Log In to Use Wallet
                  </button>
                </div>
              ) : (
                <>
                  {state.wallet ? (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.available}</p>
                        <p className="font-mono text-lg font-semibold text-neon-green">{formatCoinAmount(state.wallet.available_balance_minor)}</p>
                      </div>
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.locked}</p>
                        <p className="font-mono text-sm text-text-secondary">{formatCoinAmount(state.wallet.locked_balance_minor)}</p>
                      </div>
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.total}</p>
                        <p className="font-mono text-sm text-text-primary">{formatCoinAmount(state.wallet.total_balance_minor)}</p>
                      </div>
                    </div>
                  ) : state.walletError ? (
                    <div className="flex flex-col items-center gap-2 py-4">
                      <p className="text-center text-xs text-red-400">{state.walletError}</p>
                    </div>
                  ) : (
                    <p className="text-center text-xs text-text-secondary animate-pulse">{t.loadingWallet}</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
