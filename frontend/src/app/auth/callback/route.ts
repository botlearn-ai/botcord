import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findOrCreateUser } from "@/lib/auth";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/chats/home";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[auth/callback] exchangeCodeForSession failed:", error.message, "| status:", error.status);
    }
    if (!error) {
      // Ensure users table has a record for this Supabase user
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await findOrCreateUser({
          id: user.id,
          email: user.email,
          user_metadata: user.user_metadata,
        });
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Auth error — redirect to login with error
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
