import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  const response = await updateSession(request);

  // Beta access gate: only applies to /chats/**
  if (request.nextUrl.pathname.startsWith("/chats")) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

    if (supabaseUrl && supabaseAnonKey) {
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll() {
            // No-op: cookies already handled by updateSession
          },
        },
      });

      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        return NextResponse.redirect(new URL("/invite", request.url));
      }

      // Check JWT metadata first (fast path)
      if (user.user_metadata?.beta_access !== true) {
        // Fallback: check backend DB in case Supabase metadata sync failed
        const hubBase = process.env.NEXT_PUBLIC_HUB_BASE_URL || "https://api.botcord.chat";
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          try {
            const res = await fetch(`${hubBase}/api/users/me`, {
              headers: { Authorization: `Bearer ${session.access_token}` },
            });
            if (res.ok) {
              const me = await res.json();
              if (me.beta_access === true) {
                // DB says beta, JWT doesn't — allow access, metadata will sync eventually
                return response;
              }
            }
          } catch {
            // Backend unreachable — fall through to redirect
          }
        }
        return NextResponse.redirect(new URL("/invite", request.url));
      }
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/chats/:path*",
    "/agents/:path*",
    "/api/:path*",
    "/auth/:path*",
    "/login",
    "/invite",
  ],
};
