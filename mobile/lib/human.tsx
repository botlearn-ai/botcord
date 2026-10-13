import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useSession } from "./session";
import { supabase } from "./supabase";
import type { HumanInfo } from "./types";

export type RealtimeEvent = { type: string; room_id?: string; hub_msg_id?: string };
type Listener = (event: RealtimeEvent) => void;

type HumanState = {
  human: HumanInfo | null;
  subscribe: (listener: Listener) => () => void;
};

const HumanContext = createContext<HumanState | null>(null);

export function HumanProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [human, setHuman] = useState<HumanInfo | null>(null);
  const listeners = useRef(new Set<Listener>());
  const token = session?.access_token;

  useEffect(() => {
    api.getHumanMe().then(setHuman, () => setHuman(null));
  }, []);

  // Same private broadcast topic the dashboard subscribes to (DashboardApp.tsx).
  // Events are hints only; listeners refetch from the Hub.
  useEffect(() => {
    if (!human || !token) return;
    void supabase.realtime.setAuth(token);
    const channel = supabase
      .channel(`human:${human.human_id}`, { config: { private: true } })
      .on("broadcast", { event: "*" }, ({ payload }) => {
        for (const listener of listeners.current) listener(payload as RealtimeEvent);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [human, token]);

  const [value] = useState<Omit<HumanState, "human">>(() => ({
    subscribe(listener) {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  }));

  return <HumanContext.Provider value={{ human, ...value }}>{children}</HumanContext.Provider>;
}

export function useHuman() {
  const ctx = useContext(HumanContext);
  if (!ctx) throw new Error("useHuman must be used inside HumanProvider");
  return ctx;
}

export function useRealtime(listener: Listener) {
  const { subscribe } = useHuman();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribe((event) => ref.current(event)), [subscribe]);
}
