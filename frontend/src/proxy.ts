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

      // Logged-in users without beta_access → redirect to /invite
      if (user && user.user_metadata?.beta_access !== true) {
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
