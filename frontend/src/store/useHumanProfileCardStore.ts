/**
 * [INPUT]: Public human profiles, contact hints and the current dashboard identity.
 * [OUTPUT]: Memory-cached human cards with shared refresh requests and fenced selections.
 * [POS]: Personal dashboard profile overlay state; never used for Team surfaces.
 * [PROTOCOL]: Update this header when changing behavior, then inspect README.md.
 */
import { create } from "zustand";
import { api } from "@/lib/api";
import type { PublicHumanProfile } from "@/lib/types";
import { createProfileCache } from "@/lib/profile-cache";
import { dashboardProfileScope } from "./useDashboardChatStore";
import { useDashboardSessionStore } from "./useDashboardSessionStore";

export interface HumanProfileCard {
  human: PublicHumanProfile | null;
  loading: boolean;
  error: string | null;
  sending: boolean;
  status: "idle" | "sent" | "exists" | "pending";
}
type CardUpdate = HumanProfileCard | null | ((previous: HumanProfileCard | null) => HumanProfileCard | null);
interface HumanProfileState {
  card: HumanProfileCard | null;
  selectionVersion: number;
  setCard: (update: CardUpdate) => void;
  open: (owner: { humanId: string; displayName: string }, localContact?: boolean) => Promise<void>;
  reset: () => void;
}
const profiles = createProfileCache((id: string) => api.getPublicHuman(id));
let selectionSequence = 0;
let contactMutationSequence = 0;
function contactStatus(human: PublicHumanProfile, localContact: boolean): HumanProfileCard["status"] {
  return human.contact_status === "contact" || localContact ? "exists"
    : human.contact_status === "pending" ? "pending" : "idle";
}

export const useHumanProfileCardStore = create<HumanProfileState>()((set, get) => ({
  card: null,
  selectionVersion: 0,
  setCard: (update) => {
    const previous = get().card;
    const card = typeof update === "function" ? update(previous) : update;
    if (!card) selectionSequence += 1;
    if (card && previous && card.human?.human_id === previous.human?.human_id
      && card.status !== previous.status && card.status !== "idle") {
      // A contact mutation changes the meaning of cached profile actions.
      // clear() also fences outstanding reads, so they cannot refill the cache
      // with the status from before the mutation.
      contactMutationSequence += 1;
      profiles.clear();
    }
    set({ card, selectionVersion: selectionSequence });
  },
  reset: () => {
    selectionSequence += 1;
    profiles.clear();
    set({ card: null, selectionVersion: selectionSequence });
  },
  open: async (owner, localContact = false) => {
    const scope = dashboardProfileScope();
    const selection = ++selectionSequence;
    const mutation = contactMutationSequence;
    const cached = profiles.get(scope, owner.humanId);
    const human = cached ?? {
      human_id: owner.humanId, display_name: owner.displayName,
      avatar_url: null, created_at: null,
    };
    set({ selectionVersion: selection, card: { human, loading: !cached, error: null, sending: false, status: contactStatus(human, localContact) } });
    const isCurrent = () => selection === selectionSequence && scope === dashboardProfileScope();
    try {
      const profile = await profiles.load(scope, owner.humanId);
      if (!isCurrent()) return;
      set((state) => ({ card: state.card ? {
        ...state.card, human: profile, loading: false, error: null,
        // A just-submitted request must not be undone by an older profile read.
        status: mutation !== contactMutationSequence ? state.card.status : contactStatus(profile, localContact),
      } : null }));
    } catch (error) {
      if (!isCurrent() || mutation !== contactMutationSequence) return;
      const retained = profiles.get(scope, owner.humanId);
      set((state) => ({ card: state.card ? {
        ...state.card, loading: false,
        human: retained ?? { human_id: owner.humanId, display_name: owner.displayName, avatar_url: null, created_at: null },
        status: retained ? state.card.status : "idle",
        error: retained ? null : error instanceof Error ? error.message : "Failed to load human profile",
      } : null }));
    }
  },
}));

let lastScope = dashboardProfileScope();
useDashboardSessionStore.subscribe(() => {
  const scope = dashboardProfileScope();
  if (scope === lastScope) return;
  lastScope = scope;
  useHumanProfileCardStore.getState().reset();
});
