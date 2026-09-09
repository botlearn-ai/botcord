import { createStore } from "zustand/vanilla";
import {
  teamConversationsApi,
  type TeamMessage,
} from "@/lib/team-conversations";

interface ThreadState {
  messages: TeamMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  error: unknown;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  older: () => Promise<void>;
  cancel: () => void;
}
const merge = (a: TeamMessage[], b: TeamMessage[]) =>
  [
    ...new Map(
      [...a, ...b].map((message) => [message.sequence, message])
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);

/** One store per space/conversation. Polling never advances past unseen messages. */
export function createTeamThreadStore(spaceId: string, conversationId: string) {
  let generation = 0;
  let controller = new AbortController();
  let pending: Promise<void> | null = null;
  return createStore<ThreadState>((set, get) => ({
    messages: [],
    loading: true,
    loadingOlder: false,
    hasOlder: false,
    error: null,
    cancel: () => {
      generation++;
      controller.abort();
      pending = null;
    },
    load: async () => {
      const version = ++generation;
      controller.abort();
      controller = new AbortController();
      pending = null;
      set({
        messages: [],
        loading: true,
        error: null,
        hasOlder: false,
        loadingOlder: false,
      });
      try {
        const page = await teamConversationsApi.messages(
          spaceId,
          conversationId,
          {},
          controller.signal
        );
        if (version === generation)
          set({
            messages: page.messages,
            hasOlder: page.has_more,
            loading: false,
          });
      } catch (error) {
        if (version === generation)
          set({ error, loading: false, messages: [] });
      }
    },
    refresh: () => {
      if (pending) return pending;
      if (get().loading || get().error) return Promise.resolve();
      const version = generation;
      const task = (async () => {
        try {
          let more = true;
          while (more && version === generation) {
            const after = get().messages.at(-1)?.sequence ?? 0;
            const page = await teamConversationsApi.messages(
              spaceId,
              conversationId,
              { after },
              controller.signal
            );
            if (version !== generation) return;
            set({ messages: merge(get().messages, page.messages) });
            more = page.has_more && page.messages.length > 0;
          }
        } catch (error) {
          // Revocation and failed revalidation must not leave private history visible.
          if (version === generation) {
            generation++;
            controller.abort();
            set({ error, messages: [], hasOlder: false, loadingOlder: false });
          }
        }
      })();
      pending = task;
      void task.finally(() => {
        if (pending === task) pending = null;
      });
      return task;
    },
    older: async () => {
      if (get().loadingOlder || !get().hasOlder || get().error) return;
      const version = generation;
      set({ loadingOlder: true });
      try {
        const page = await teamConversationsApi.messages(
          spaceId,
          conversationId,
          { before: get().messages[0].sequence },
          controller.signal
        );
        if (version === generation)
          set({
            messages: merge(page.messages, get().messages),
            hasOlder: page.has_more,
          });
      } catch (error) {
        if (version === generation) {
          generation++;
          controller.abort();
          set({ error, messages: [], hasOlder: false, loadingOlder: false });
        }
      } finally {
        if (version === generation) set({ loadingOlder: false });
      }
    },
  }));
}
