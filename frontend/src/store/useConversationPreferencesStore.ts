import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Preferences {
  pinned: string[];
  hidden: Record<string, number>;
}
export const EMPTY_CONVERSATION_PREFERENCES: Preferences = { pinned: [], hidden: {} };

interface ConversationPreferencesState {
  accounts: Record<string, Preferences>;
  togglePin: (account: string, roomId: string) => void;
  hide: (account: string, roomId: string, latestMessageAt: number) => void;
  show: (account: string, roomId: string) => void;
}

/** Device-local list preferences, isolated by authenticated account. */
export const useConversationPreferencesStore = create<ConversationPreferencesState>()(persist((set) => ({
  accounts: {},
  togglePin: (account, roomId) => set((state) => {
    const current = state.accounts[account] ?? EMPTY_CONVERSATION_PREFERENCES;
    const pinned = current.pinned.includes(roomId)
      ? current.pinned.filter((id) => id !== roomId) : [...current.pinned, roomId];
    return { accounts: { ...state.accounts, [account]: { ...current, pinned } } };
  }),
  hide: (account, roomId, latestMessageAt) => set((state) => {
    const current = state.accounts[account] ?? EMPTY_CONVERSATION_PREFERENCES;
    return { accounts: { ...state.accounts, [account]: {
      ...current, hidden: { ...current.hidden, [roomId]: latestMessageAt },
    } } };
  }),
  show: (account, roomId) => set((state) => {
    const current = state.accounts[account];
    if (!current || !(roomId in current.hidden)) return state;
    const hidden = { ...current.hidden };
    delete hidden[roomId];
    return { accounts: { ...state.accounts, [account]: { ...current, hidden } } };
  }),
}), { name: "botcord-conversation-preferences", partialize: (state) => ({ accounts: state.accounts }) }));
