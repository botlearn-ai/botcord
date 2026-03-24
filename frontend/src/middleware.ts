import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const BETA_PROTECTED_PATHS = ["/chats"];

function isBetaProtected(pathname: string): boolean {
  return BETA_PROTECTED_PATHS.some((prefix) => pathname.startsWith(prefix));
}

export async function middleware(request: NextRequest) {
  // Always refresh Supabase session first
  const response = await updateSession(request);

  const { pathname } = request.nextUrl;

  // Only apply beta gate to /chats/** routes
  if (!isBetaProtected(pathname)) {
    return response;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

  // Read the user session from cookies (set by updateSession above)
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll() {
        // No-op: cookies already set by updateSession
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Not logged in → let the dashboard handle its own auth redirect
  if (!user) {
    return response;
  }

  // Check beta_access from user_metadata (set by backend after redeeming)
  const betaAccess = user.user_metadata?.beta_access === true;
  if (!betaAccess) {
    const inviteUrl = new URL("/invite", request.url);
    return NextResponse.redirect(inviteUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     * - public assets
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
