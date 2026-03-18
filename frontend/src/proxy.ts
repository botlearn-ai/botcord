import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Only run Supabase session refresh on auth-related routes:
     * - /chats (dashboard)
     * - /api (API routes)
     * - /auth (auth callbacks)
     * - /login
     */
    "/chats/:path*",
    "/api/:path*",
    "/auth/:path*",
    "/login",
  ],
};
