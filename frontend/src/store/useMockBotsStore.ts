/**
 * Preview-only shared state for bots created via the home-page mock flow.
 * Lifted out of HomePanel so MyBotsPanel can read the same list.
 */

import { create } from "zustand";

export type MockCreatedBot = {
  id: string;
  name: string;
  bio: string | null;
  runtimeId: string;
  deviceId: string;
};

export type MockCreatedBotDraft = Omit<MockCreatedBot, "id">;

interface MockBotsState {
  bots: MockCreatedBot[];
  addBot: (draft: MockCreatedBotDraft) => void;
}

export const useMockBotsStore = create<MockBotsState>((set) => ({
  bots: [],
  addBot: (draft) =>
    set((state) => ({
      bots: [
        { ...draft, id: `mock_local_bot_${state.bots.length + 1}` },
        ...state.bots,
      ],
    })),
}));
