"use client";

/**
 * [INPUT]: 依赖 react 的 startTransition/useEffect 解耦导航切换与路由提交，依赖 session/ui/chat/unread/wallet store 提供导航状态、会话未读与业务动作，依赖 nextjs-toploader/app 的 useRouter 承载全局切换反馈，依赖 AccountMenu 承载账号与 agent 入口
 * [OUTPUT]: 对外提供 Sidebar 组件，渲染统一的一级/二级导航、会话列表、未读提示与左下角账户菜单
 * [POS]: dashboard 左侧导航骨架，负责频道切换、未读入口提示与全局入口编排；无 agent 准入由 DashboardApp 顶层统一处理
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { startTransition, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from '@/lib/i18n';
import { sidebar } from '@/lib/i18n/translations/dashboard';
import { common, nav } from '@/lib/i18n/translations/common';
import { useShallow } from "zustand/react/shallow";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import RoomList from "./RoomList";
import AccountMenu from "./AccountMenu";
import RoomZeroState from "./RoomZeroState";
import { createClient } from "@/lib/supabase/client";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";

const USER_CHAT_ROUTE = "/chats/messages/__user-chat__";

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const authNavItems = [
  {
    key: "messages" as const,
    label: "Messages",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
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

interface PrimaryNavButtonProps {
  active: boolean;
  activeTone: "cyan" | "purple";
  badge?: ReactNode;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title: string;
}

function PrimaryNavButton({
  active,
  activeTone,
  badge,
  disabled = false,
  icon,
  label,
  onClick,
  title,
}: PrimaryNavButtonProps) {
  const activeClass = activeTone === "purple"
    ? "bg-neon-purple/15 text-neon-purple"
    : "bg-neon-cyan/15 text-neon-cyan";
  const indicatorClass = activeTone === "purple" ? "bg-neon-purple" : "bg-neon-cyan";

  return (
    <button
      onClick={onClick}
      className={`group relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition-all duration-200 ${
        disabled
          ? "text-text-secondary/45 hover:bg-neon-cyan/10 hover:text-neon-cyan"
          : active
          ? activeClass
          : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
      }`}
      title={title}
    >
      {active && !disabled && (
        <div className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full ${indicatorClass}`} />
      )}
      {badge}
      {icon}
      <span className="mt-0.5 text-[9px] font-medium leading-none">{label}</span>
    </button>
  );
}

interface SecondaryNavButtonProps {
  active: boolean;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
  onClick: () => void;
  tone: "cyan" | "purple";
}

function SecondaryNavButton({
  active,
  badge,
  children,
  className = "",
  onClick,
  tone,
}: SecondaryNavButtonProps) {
  const activeClass = tone === "purple"
    ? "border-neon-purple/60 bg-neon-purple/10 text-neon-purple"
    : "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan";

  return (
    <button
      onClick={onClick}
      className={`${className} w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
        active ? activeClass : "border-glass-border text-text-secondary hover:text-text-primary"
      }`}
    >
      {badge ? (
        <span className="flex items-center justify-between gap-3">
          <span>{children}</span>
          {badge}
        </span>
      ) : (
        children
      )}
    </button>
  );
}

export default function Sidebar() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const locale = useLanguage();
  const t = sidebar[locale];
  const tc = common[locale];
  const tNav = nav[locale];
  const sessionStore = useDashboardSessionStore(useShallow((state) => ({
    user: state.user,
    ownedAgents: state.ownedAgents,
    activeAgentId: state.activeAgentId,
    sessionMode: state.sessionMode,
    token: state.token,
    refreshUserProfile: state.refreshUserProfile,
    logout: state.logout,
  })));
  const uiStore = useDashboardUIStore(useShallow((state) => ({
    sidebarTab: state.sidebarTab,
    contactsView: state.contactsView,
    exploreView: state.exploreView,
    openedRoomId: state.openedRoomId,
    messagesPane: state.messagesPane,
    setSidebarTab: state.setSidebarTab,
    setMessagesPane: state.setMessagesPane,
    setExploreView: state.setExploreView,
    setContactsView: state.setContactsView,
  })));
  const chatStore = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    recentVisitedRooms: state.recentVisitedRooms,
    switchActiveAgent: state.switchActiveAgent,
  })));
  const optimisticUnreadRoomIds = useDashboardUnreadStore((state) => state.optimisticUnreadRoomIds);
  const wallet = useDashboardWalletStore(useShallow((state) => ({
    wallet: state.wallet,
    walletError: state.walletError,
  })));
  const isGuest = sessionStore.sessionMode === "guest";
  const showLoginModal = () => router.push("/login");
  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.warn("[Dashboard] Supabase signOut failed:", error.message);
    }
    sessionStore.logout();
    useDashboardUIStore.getState().logout();
    useDashboardChatStore.getState().logout();
    useDashboardUnreadStore.getState().logout();
    useDashboardContactStore.getState().resetContactState();
    useDashboardWalletStore.getState().resetWalletState();
    router.push("/login");
  };

  const tabTitles: Record<string, string> = {
    messages: t.messages,
    contacts: t.contacts,
    explore: t.discover,
    wallet: t.wallet,
  };

  const navItems = authNavItems;

  const visibleMessageRooms = useMemo(
    () => buildVisibleMessageRooms({
      overview: chatStore.overview,
      recentVisitedRooms: chatStore.recentVisitedRooms,
      token: sessionStore.token,
    }),
    [chatStore.overview, chatStore.recentVisitedRooms, sessionStore.token],
  );
  const showOverviewSkeleton =
    sessionStore.sessionMode === "authed-ready" && !chatStore.overview && uiStore.sidebarTab === "messages";
  const hasUnreadMessages = optimisticUnreadRoomIds.length > 0 || visibleMessageRooms.some((room) => room.has_unread);
  const pendingContactRequests = chatStore.overview?.pending_requests || 0;

  useEffect(() => {
    const prefetch = (path: string) => {
      if (typeof router.prefetch !== "function") {
        return;
      }
      void router.prefetch(path);
    };

    prefetch("/chats/messages");
    prefetch(`/chats/contacts/${uiStore.contactsView}`);
    prefetch(`/chats/explore/${uiStore.exploreView}`);
    prefetch("/chats/wallet");
  }, [router, uiStore.contactsView, uiStore.exploreView]);

  const navigatePrimaryTab = (tab: "messages" | "contacts" | "explore" | "wallet") => {
    if (isGuest && tab === "contacts") {
      showLoginModal();
      return;
    }
    const openedRoomPath = uiStore.openedRoomId
      ? `/chats/messages/${encodeURIComponent(uiStore.openedRoomId)}`
      : uiStore.messagesPane === "user-chat"
        ? USER_CHAT_ROUTE
        : "/chats/messages";
    const pathByTab: Record<typeof tab, string> = {
      messages: openedRoomPath,
      contacts: `/chats/contacts/${uiStore.contactsView}`,
      explore: `/chats/explore/${uiStore.exploreView}`,
      wallet: "/chats/wallet",
    };
    uiStore.setSidebarTab(tab);
    if (tab === "messages" && !uiStore.openedRoomId && uiStore.messagesPane !== "user-chat") {
      uiStore.setMessagesPane("room");
    }
    startTransition(() => {
      router.push(pathByTab[tab]);
    });
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
            const isActive = uiStore.sidebarTab === item.key;
            const isExplore = item.key === "explore";
            const requiresLogin = isGuest && item.key === "contacts";
            let badge: ReactNode = null;
            if (item.key === "messages" && hasUnreadMessages && !requiresLogin) {
              badge = (
                <div className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-neon-cyan shadow-[0_0_10px_rgba(34,211,238,0.6)]" />
              );
            }
            if (item.key === "contacts" && pendingContactRequests > 0 && !requiresLogin) {
              badge = (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neon-cyan px-1 text-[9px] font-bold text-black shadow-[0_0_12px_rgba(34,211,238,0.45)]">
                  {pendingContactRequests > 9 ? "9+" : pendingContactRequests}
                </span>
              );
            }
            return (
              <PrimaryNavButton
                key={item.key}
                onClick={() => navigatePrimaryTab(item.key)}
                active={isActive}
                activeTone={isExplore ? "purple" : "cyan"}
                badge={badge}
                disabled={requiresLogin}
                icon={item.icon}
                label={tabTitles[item.key] || item.label}
                title={requiresLogin ? tc.login : tabTitles[item.key] || item.label}
              />
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
            <AccountMenu
              user={sessionStore.user}
              agents={sessionStore.ownedAgents}
              activeAgentId={sessionStore.activeAgentId}
              pendingRequests={chatStore.overview?.pending_requests || 0}
              onSwitchAgent={chatStore.switchActiveAgent}
              onLogout={handleLogout}
              onAgentBound={async (agentId) => {
                await sessionStore.refreshUserProfile();
                await chatStore.switchActiveAgent(agentId);
              }}
            />
          )}
        </div>
      </div>

      {/* Secondary panel */}
      <div className="flex h-full w-[260px] min-w-[260px] flex-col border-r border-glass-border bg-deep-black-light">
        {/* Panel header */}
        <div className="flex min-h-14 items-center justify-between border-b border-glass-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {tabTitles[uiStore.sidebarTab]}
            </h2>
            {isGuest && (
              <p className="truncate text-[10px] text-text-secondary/60">
                {t.browseAsGuest}
              </p>
            )}
          </div>
        </div>

        {/* Secondary navigation */}
        {uiStore.sidebarTab === "explore" && (
          <div className="border-b border-glass-border p-3">
            <SecondaryNavButton
              onClick={() => {
                uiStore.setExploreView("rooms");
                startTransition(() => {
                  router.push("/chats/explore/rooms");
                });
              }}
              active={uiStore.exploreView === "rooms"}
              tone="purple"
            >
              {t.publicRooms}
            </SecondaryNavButton>
            <SecondaryNavButton
              onClick={() => {
                uiStore.setExploreView("agents");
                startTransition(() => {
                  router.push("/chats/explore/agents");
                });
              }}
              active={uiStore.exploreView === "agents"}
              className="mt-2"
              tone="purple"
            >
              {t.agents}
            </SecondaryNavButton>
          </div>
        )}

        {uiStore.sidebarTab === "contacts" && (
          <div className="border-b border-glass-border p-3">
            <SecondaryNavButton
              onClick={() => {
                uiStore.setContactsView("agents");
                startTransition(() => {
                  router.push("/chats/contacts/agents");
                });
              }}
              active={uiStore.contactsView === "agents"}
              tone="cyan"
            >
              {t.agents}
            </SecondaryNavButton>
            <SecondaryNavButton
              onClick={() => {
                uiStore.setContactsView("requests");
                startTransition(() => {
                  router.push("/chats/contacts/requests");
                });
              }}
              active={uiStore.contactsView === "requests"}
              badge={pendingContactRequests > 0 ? (
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-neon-cyan px-1.5 text-[10px] font-bold text-black">
                  {pendingContactRequests > 99 ? "99+" : pendingContactRequests}
                </span>
              ) : undefined}
              className="mt-2"
              tone="cyan"
            >
              {t.requests}
            </SecondaryNavButton>
            <SecondaryNavButton
              onClick={() => {
                uiStore.setContactsView("rooms");
                startTransition(() => {
                  router.push("/chats/contacts/rooms");
                });
              }}
              active={uiStore.contactsView === "rooms"}
              className="mt-2"
              tone="cyan"
            >
              {t.joinedRooms}
            </SecondaryNavButton>
          </div>
        )}

        {/* Panel content */}
        <div className="flex-1 overflow-y-auto">
          {uiStore.sidebarTab === "messages" && (
            <div className="py-1">
              {visibleMessageRooms.length === 0 && !sessionStore.activeAgentId ? (
                <RoomZeroState compact />
              ) : (
                <RoomList rooms={visibleMessageRooms} loading={showOverviewSkeleton} />
              )}
            </div>
          )}

          {uiStore.sidebarTab === "wallet" && (
            <div className="p-4">
              {isGuest ? (
                <div className="rounded-xl border border-glass-border bg-glass-bg p-6 text-center">
                  <div className="mb-4 flex justify-center text-neon-cyan">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-12 w-12">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
                    </svg>
                  </div>
                  <h3 className="mb-2 text-sm font-semibold text-text-primary">{t.walletSupportTitle}</h3>
                  <p className="mb-6 text-xs text-text-secondary leading-relaxed">
                    {t.walletSupportDesc}
                  </p>
                  <button
                    onClick={showLoginModal}
                    className="w-full rounded-lg bg-neon-cyan/10 py-2.5 text-xs font-semibold text-neon-cyan transition-all hover:bg-neon-cyan/20 border border-neon-cyan/20"
                  >
                    {t.loginToUseWallet}
                  </button>
                </div>
              ) : (
                <>
                  {wallet.wallet ? (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.available}</p>
                        <p className="font-mono text-lg font-semibold text-neon-green">{formatCoinAmount(wallet.wallet.available_balance_minor)}</p>
                      </div>
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.locked}</p>
                        <p className="font-mono text-sm text-text-secondary">{formatCoinAmount(wallet.wallet.locked_balance_minor)}</p>
                      </div>
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.total}</p>
                        <p className="font-mono text-sm text-text-primary">{formatCoinAmount(wallet.wallet.total_balance_minor)}</p>
                      </div>
                    </div>
                  ) : wallet.walletError ? (
                    <div className="flex flex-col items-center gap-2 py-4">
                      <p className="text-center text-xs text-red-400">{wallet.walletError}</p>
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
