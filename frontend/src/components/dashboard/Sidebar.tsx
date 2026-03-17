import { useDashboard } from "./DashboardApp";
import RoomList from "./RoomList";
import ContactList from "./ContactList";
import DiscoverRoomList from "./DiscoverRoomList";
import PublicRoomList from "./PublicRoomList";
import PublicAgentList from "./PublicAgentList";

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const authNavItems = [
  {
    key: "rooms" as const,
    label: "Rooms",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M20 12c0-1.1-.9-2-2-2h-1V7a4 4 0 0 0-8 0v1H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M2 8.5h3M2 12h3M2 15.5h3M19 8.5h3M19 12h3M19 15.5h3" />
      </svg>
    ),
  },
  {
    key: "contacts" as const,
    label: "Contacts",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
      </svg>
    ),
  },
  {
    key: "discover" as const,
    label: "Discover",
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
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
    ),
  },
] as const;

const guestNavItems = [
  {
    key: "discover" as const,
    label: "Rooms",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.732-3.558" />
      </svg>
    ),
  },
  {
    key: "agents" as const,
    label: "Agents",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
      </svg>
    ),
  },
] as const;

const tabTitles: Record<string, string> = {
  rooms: "Rooms",
  contacts: "Contacts",
  discover: "Discover",
  agents: "Agents",
  wallet: "Wallet",
};

export default function Sidebar() {
  const { state, dispatch, refreshOverview, isGuest, showLoginModal } = useDashboard();

  const navItems = isGuest ? guestNavItems : authNavItems;

  return (
    <div className="flex h-full">
      {/* Primary rail */}
      <div className="flex h-full w-16 min-w-[64px] flex-col items-center border-r border-glass-border bg-deep-black py-3">
        {/* Nav icons */}
        <div className="flex flex-1 flex-col items-center gap-1 pt-1">
          {navItems.map((item) => {
            const isActive = state.sidebarTab === item.key;
            const isDiscover = item.key === "discover" && !isGuest;
            return (
              <button
                key={item.key}
                onClick={() => dispatch({ type: "SET_SIDEBAR_TAB", tab: item.key })}
                className={`group relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition-all duration-200 ${
                  isActive
                    ? isDiscover
                      ? "bg-neon-purple/15 text-neon-purple"
                      : "bg-neon-cyan/15 text-neon-cyan"
                    : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                }`}
                title={item.label}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <div className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full ${isDiscover ? "bg-neon-purple" : "bg-neon-cyan"}`} />
                )}
                {item.icon}
                <span className="mt-0.5 text-[9px] font-medium leading-none">{item.label}</span>
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
              title="Login"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m-6 0 3 3m0 0 3-3m-3 3V9" />
              </svg>
              <span className="mt-0.5 text-[9px] font-medium leading-none">Login</span>
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
                title="Refresh"
              >
                <span className={`text-sm ${state.loading ? "inline-block animate-spin" : ""}`}>&#x21BB;</span>
              </button>
              <button
                onClick={() => dispatch({ type: "LOGOUT" })}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-glass-bg hover:text-red-400"
                title="Logout"
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
        {/* Panel header */}
        <div className="flex items-center justify-between border-b border-glass-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {isGuest && state.sidebarTab === "discover" ? "Public Rooms" : tabTitles[state.sidebarTab]}
              {!isGuest && state.sidebarTab === "rooms" && state.overview && (
                <span className="ml-1.5 text-xs font-normal text-text-secondary">
                  {state.overview.rooms.length}
                </span>
              )}
              {!isGuest && state.sidebarTab === "contacts" && state.overview && (
                <span className="ml-1.5 text-xs font-normal text-text-secondary">
                  {state.overview.contacts.length}
                </span>
              )}
              {isGuest && state.sidebarTab === "discover" && (
                <span className="ml-1.5 text-xs font-normal text-text-secondary">
                  {state.publicRooms.length}
                </span>
              )}
              {isGuest && state.sidebarTab === "agents" && (
                <span className="ml-1.5 text-xs font-normal text-text-secondary">
                  {state.publicAgents.length}
                </span>
              )}
            </h2>
            {!isGuest && state.sidebarTab === "rooms" && (
              <p className="truncate font-mono text-[10px] text-text-secondary/60">
                {state.overview?.agent.display_name}
              </p>
            )}
            {isGuest && (
              <p className="truncate text-[10px] text-text-secondary/60">
                Browse as guest
              </p>
            )}
          </div>
        </div>

        {/* Panel content */}
        <div className="flex-1 overflow-y-auto">
          {isGuest ? (
            <>
              {state.sidebarTab === "discover" && <PublicRoomList />}
              {state.sidebarTab === "agents" && <PublicAgentList />}
            </>
          ) : (
            <>
              {state.sidebarTab === "rooms" && <RoomList />}
              {state.sidebarTab === "contacts" && <ContactList />}
              {state.sidebarTab === "discover" && <DiscoverRoomList />}
              {state.sidebarTab === "wallet" && (
                <div className="p-4">
                  {state.wallet ? (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">Available</p>
                        <p className="font-mono text-lg font-semibold text-neon-green">{formatCoinAmount(state.wallet.available_balance_minor)}</p>
                      </div>
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">Locked</p>
                        <p className="font-mono text-sm text-text-secondary">{formatCoinAmount(state.wallet.locked_balance_minor)}</p>
                      </div>
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">Total</p>
                        <p className="font-mono text-sm text-text-primary">{formatCoinAmount(state.wallet.total_balance_minor)}</p>
                      </div>
                    </div>
                  ) : state.walletError ? (
                    <div className="flex flex-col items-center gap-2 py-4">
                      <p className="text-center text-xs text-red-400">{state.walletError}</p>
                    </div>
                  ) : (
                    <p className="text-center text-xs text-text-secondary animate-pulse">Loading wallet...</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
