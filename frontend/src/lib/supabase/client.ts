import { createBrowserClient } from "@supabase/ssr";
import { DEV_BYPASS_AUTH, DEV_FAKE_SESSION } from "@/lib/dev-bypass";

function createDevBypassClient(): ReturnType<typeof createBrowserClient> {
  const fakeSubscription = { unsubscribe: () => {} };
  // Channel that pretends to subscribe but never connects to a real broker.
  const makeChannel = () => {
    const channel: Record<string, unknown> = {};
    channel.on = () => channel;
    channel.subscribe = (cb?: (status: string, err?: unknown) => void) => {
      // Defer the callback so any synchronous .on(...) chains complete first.
      if (typeof cb === "function") {
        setTimeout(() => {
          try {
            cb("CHANNEL_ERROR", new Error("dev-bypass: no realtime"));
          } catch {
            /* swallow */
          }
        }, 0);
      }
      return channel;
    };
    channel.unsubscribe = async () => "ok";
    channel.send = async () => "ok";
    return channel;
  };

  const fake = {
    auth: {
      getSession: async () => ({ data: { session: DEV_FAKE_SESSION }, error: null }),
      getUser: async () => ({ data: { user: DEV_FAKE_SESSION.user }, error: null }),
      onAuthStateChange: (_cb: unknown) => ({
        data: { subscription: fakeSubscription },
      }),
      signOut: async () => ({ error: null }),
      setSession: async () => ({
        data: { session: DEV_FAKE_SESSION, user: DEV_FAKE_SESSION.user },
        error: null,
      }),
      refreshSession: async () => ({
        data: { session: DEV_FAKE_SESSION, user: DEV_FAKE_SESSION.user },
        error: null,
      }),
    },
    realtime: {
      setAuth: (_token?: string) => {},
    },
    channel: (_topic: string, _opts?: unknown) => makeChannel(),
    removeChannel: (_ch: unknown) => "ok",
    removeAllChannels: () => "ok",
  };

  return fake as unknown as ReturnType<typeof createBrowserClient>;
}

export function createClient() {
  if (DEV_BYPASS_AUTH) {
    return createDevBypassClient();
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!;

  return createBrowserClient(supabaseUrl, supabaseKey);
}
