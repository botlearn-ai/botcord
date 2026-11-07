import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  getServerSupabaseUrl,
  getSupabaseAuthCookieName,
} from "@/lib/server-endpoints";

export async function createClient() {
  const cookieStore = await cookies();

  const publicSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseUrl = getServerSupabaseUrl(publicSupabaseUrl);
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!;

  return createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookieOptions: {
        name: getSupabaseAuthCookieName(publicSupabaseUrl),
      },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    },
  );
}
