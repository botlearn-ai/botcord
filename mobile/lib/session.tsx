import type { Session } from "@supabase/supabase-js";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { supabase } from "./supabase";

type SessionState = { session: Session | null; loading: boolean };

const SessionContext = createContext<SessionState>({ session: null, loading: true });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, loading: true });

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setState({ session: data.session, loading: false });
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, loading: false });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
