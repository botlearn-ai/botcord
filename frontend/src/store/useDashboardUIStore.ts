/**
 * [INPUT]: 依赖 zustand 保存 dashboard 纯界面状态，不直接持有远端数据与同步逻辑
 * [OUTPUT]: 对外提供 useDashboardUIStore，管理路由同构 tab、房间焦点与 Agent 卡片开合状态
 * [POS]: frontend dashboard 的 UI 域状态源，负责界面导航与模态/面板控制
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";

export interface DashboardUIState {
  focusedRoomId: string | null;
  openedRoomId: string | null;
  /** Separate slot for the user-chat pane so it doesn't clobber openedRoomId. */
  userChatRoomId: string | null;
  rightPanelOpen: boolean;
  agentCardOpen: boolean;
  /** When set, the topic side drawer is open for this topic_id in the opened room. */
  openedTopicId: string | null;
  sidebarTab: "messages" | "contacts" | "explore" | "wallet" | "activity";
  /** Distinguish the fixed user-chat entry from ordinary message rooms. */
  messagesPane: "room" | "user-chat";
  exploreView: "rooms" | "agents" | "templates";
  contactsView: "agents" | "requests" | "rooms" | "created";

  setFocusedRoomId: (roomId: string | null) => void;
  setOpenedRoomId: (roomId: string | null) => void;
  setUserChatRoomId: (roomId: string | null) => void;
  setSidebarTab: (tab: DashboardUIState["sidebarTab"]) => void;
  setMessagesPane: (pane: DashboardUIState["messagesPane"]) => void;
  setExploreView: (view: DashboardUIState["exploreView"]) => void;
  setContactsView: (view: DashboardUIState["contactsView"]) => void;
  setOpenedTopicId: (topicId: string | null) => void;
  toggleRightPanel: () => void;
  openAgentCard: () => void;
  closeAgentCard: () => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  resetUIState: () => void;
  logout: () => void;
}

const initialUIState = {
  focusedRoomId: null,
  openedRoomId: null,
  userChatRoomId: null,
  rightPanelOpen: false,
  agentCardOpen: false,
  openedTopicId: null as string | null,
  sidebarTab: "messages" as const,
  messagesPane: "room" as const,
  exploreView: "rooms" as const,
  contactsView: "agents" as const,
  sidebarWidth: 260,
};

export const useDashboardUIStore = create<DashboardUIState>()((set) => ({
  ...initialUIState,

  setFocusedRoomId: (focusedRoomId) =>
    set((state) => (state.focusedRoomId === focusedRoomId ? state : { focusedRoomId })),
  setOpenedRoomId: (openedRoomId) =>
    set((state) => (state.openedRoomId === openedRoomId ? state : { openedRoomId })),
  setUserChatRoomId: (userChatRoomId) =>
    set((state) => (state.userChatRoomId === userChatRoomId ? state : { userChatRoomId })),
  setSidebarTab: (sidebarTab) =>
    set((state) => (state.sidebarTab === sidebarTab ? state : { sidebarTab })),
  setMessagesPane: (messagesPane) =>
    set((state) => (state.messagesPane === messagesPane ? state : { messagesPane })),
  setExploreView: (exploreView) =>
    set((state) => (state.exploreView === exploreView ? state : { exploreView })),
  setContactsView: (contactsView) =>
    set((state) => (state.contactsView === contactsView ? state : { contactsView })),
  setOpenedTopicId: (openedTopicId) =>
    set((state) => (state.openedTopicId === openedTopicId ? state : { openedTopicId })),
  setSidebarWidth: (sidebarWidth) =>
    set((state) => (state.sidebarWidth === sidebarWidth ? state : { sidebarWidth })),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  openAgentCard: () => set({ agentCardOpen: true }),
  closeAgentCard: () => set({ agentCardOpen: false }),
  resetUIState: () =>
    set((state) => ({
      ...initialUIState,
      sidebarTab: state.sidebarTab,
      exploreView: state.exploreView,
      contactsView: state.contactsView,
    })),
  logout: () => set({ ...initialUIState, sidebarTab: "messages" }),
}));
