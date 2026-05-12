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
  /** Dispatch slot: a component requests opening the HumanCardModal for a given human. */
  pendingHumanOpen: { humanId: string; displayName: string } | null;
  /** When set, the topic side drawer is open for this topic_id in the opened room. */
  openedTopicId: string | null;
  /** Mobile-only temporary drawer for the secondary sidebar/list panel. */
  mobileSidebarOpen: boolean;
  sidebarTab: "home" | "messages" | "contacts" | "explore" | "wallet" | "activity" | "bots";
  /** Currently selected owned bot (agent_id) in the My Bots tab. Null = list view. */
  selectedBotAgentId: string | null;
  setSelectedBotAgentId: (agentId: string | null) => void;
  /** Controls the Create Bot modal visibility from any component. */
  createBotModalOpen: boolean;
  openCreateBotModal: () => void;
  closeCreateBotModal: () => void;
  /** Distinguish the fixed user-chat entry from ordinary message rooms. */
  messagesPane: "room" | "user-chat";
  /** Active leaf filter in the Messages grouping sidebar. */
  messagesFilter:
    | "self-all"
    | "self-my-bot"
    | "self-third-bot"
    | "self-human"
    | "self-group"
    | "bots-all"
    | "bots-bot-bot"
    | "bots-bot-human"
    | "bots-group";
  /**
   * Messages identity scope: whose conversations are listed.
   *  - "human": my own (Jin's) conversations
   *  - { type: "agent", id }: owned bot's conversations — read-only for owner
   */
  messagesScope: { type: "human" } | { type: "agent"; id: string };
  /** Whether the identity-grouping sidebar in Messages is expanded. */
  messagesGroupingOpen: boolean;
  /** Whether the inline search field in the Messages panel is visible. */
  messagesSearchOpen: boolean;
  /**
   * In Bot 监控 view (filter = bots-*), narrows the list to a specific owned
   * bot's conversations. "all" = no narrowing. Persists across filter
   * switches so users keep their focus when toggling between sub-filters.
   */
  messagesBotScope: "all" | string;
  exploreView: "rooms" | "agents" | "humans" | "templates";
  contactsView: "agents" | "requests" | "rooms" | "created";
  /** Selection in the Contacts list (drives the right-side detail pane). */
  selectedContactKey: { type: "agent" | "human" | "group"; id: string } | null;

  setFocusedRoomId: (roomId: string | null) => void;
  setOpenedRoomId: (roomId: string | null) => void;
  setUserChatRoomId: (roomId: string | null) => void;
  setSidebarTab: (tab: DashboardUIState["sidebarTab"]) => void;
  setMessagesPane: (pane: DashboardUIState["messagesPane"]) => void;
  setMessagesFilter: (filter: DashboardUIState["messagesFilter"]) => void;
  setMessagesScope: (scope: DashboardUIState["messagesScope"]) => void;
  setMessagesGroupingOpen: (open: boolean) => void;
  setMessagesSearchOpen: (open: boolean) => void;
  setMessagesBotScope: (scope: DashboardUIState["messagesBotScope"]) => void;
  setExploreView: (view: DashboardUIState["exploreView"]) => void;
  setContactsView: (view: DashboardUIState["contactsView"]) => void;
  setSelectedContactKey: (key: DashboardUIState["selectedContactKey"]) => void;
  setOpenedTopicId: (topicId: string | null) => void;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
  toggleRightPanel: () => void;
  openAgentCard: () => void;
  closeAgentCard: () => void;
  requestOpenHuman: (humanId: string, displayName: string) => void;
  clearPendingHumanOpen: () => void;
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
  pendingHumanOpen: null as { humanId: string; displayName: string } | null,
  openedTopicId: null as string | null,
  mobileSidebarOpen: false,
  sidebarTab: "messages" as DashboardUIState["sidebarTab"],
  selectedBotAgentId: null as string | null,
  messagesPane: "room" as const,
  messagesFilter: "self-all" as DashboardUIState["messagesFilter"],
  messagesScope: { type: "human" as const } as DashboardUIState["messagesScope"],
  messagesGroupingOpen: true,
  messagesSearchOpen: false,
  messagesBotScope: "all" as DashboardUIState["messagesBotScope"],
  exploreView: "rooms" as const,
  contactsView: "agents" as const,
  selectedContactKey: null as DashboardUIState["selectedContactKey"],
  sidebarWidth: 360,
  createBotModalOpen: false,
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
  setSelectedBotAgentId: (selectedBotAgentId) =>
    set((state) => (state.selectedBotAgentId === selectedBotAgentId ? state : { selectedBotAgentId })),
  setMessagesPane: (messagesPane) =>
    set((state) => (state.messagesPane === messagesPane ? state : { messagesPane })),
  setMessagesFilter: (messagesFilter) =>
    set((state) => (state.messagesFilter === messagesFilter ? state : { messagesFilter })),
  setMessagesScope: (messagesScope) =>
    set((state) => {
      const a = state.messagesScope;
      const b = messagesScope;
      if (a.type === "human" && b.type === "human") return state;
      if (a.type === "agent" && b.type === "agent" && a.id === b.id) return state;
      return { messagesScope };
    }),
  setMessagesGroupingOpen: (messagesGroupingOpen) =>
    set((state) => (state.messagesGroupingOpen === messagesGroupingOpen ? state : { messagesGroupingOpen })),
  setMessagesSearchOpen: (messagesSearchOpen) =>
    set((state) => (state.messagesSearchOpen === messagesSearchOpen ? state : { messagesSearchOpen })),
  setMessagesBotScope: (messagesBotScope) =>
    set((state) => (state.messagesBotScope === messagesBotScope ? state : { messagesBotScope })),
  setExploreView: (exploreView) =>
    set((state) => (state.exploreView === exploreView ? state : { exploreView })),
  setContactsView: (contactsView) =>
    set((state) => (state.contactsView === contactsView ? state : { contactsView })),
  setSelectedContactKey: (selectedContactKey) =>
    set((state) => {
      const a = state.selectedContactKey;
      const b = selectedContactKey;
      if (a === b) return state;
      if (a && b && a.type === b.type && a.id === b.id) return state;
      return { selectedContactKey };
    }),
  setOpenedTopicId: (openedTopicId) =>
    set((state) => (state.openedTopicId === openedTopicId ? state : { openedTopicId })),
  openMobileSidebar: () => set({ mobileSidebarOpen: true }),
  closeMobileSidebar: () => set({ mobileSidebarOpen: false }),
  setSidebarWidth: (sidebarWidth) =>
    set((state) => (state.sidebarWidth === sidebarWidth ? state : { sidebarWidth })),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  openAgentCard: () => set({ agentCardOpen: true }),
  closeAgentCard: () => set({ agentCardOpen: false }),
  requestOpenHuman: (humanId, displayName) => set({ pendingHumanOpen: { humanId, displayName } }),
  clearPendingHumanOpen: () => set({ pendingHumanOpen: null }),
  openCreateBotModal: () => set({ createBotModalOpen: true }),
  closeCreateBotModal: () => set({ createBotModalOpen: false }),
  resetUIState: () =>
    set((state) => ({
      ...initialUIState,
      sidebarTab: state.sidebarTab,
      exploreView: state.exploreView,
      contactsView: state.contactsView,
    })),
  logout: () => set({ ...initialUIState, sidebarTab: "messages" }),
}));
