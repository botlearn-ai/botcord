/**
 * [INPUT]: server-only and public service URL environment variables
 * [OUTPUT]: internal-first service URLs, stable auth cookie naming, and safe public auth redirects
 * [POS]: Next server networking boundary; browser code must continue using NEXT_PUBLIC_* URLs
 * [PROTOCOL]: keep Supabase cookie naming identical to @supabase/supabase-js defaults
 */

export function getServerHubBaseUrl(): string {
  return (
    process.env.HUB_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_HUB_BASE_URL ||
    (process.env.NODE_ENV === "development"
      ? "http://localhost:8000"
      : "https://api.botcord.chat")
  );
}

export function getServerSupabaseUrl(publicUrl: string): string {
  return process.env.SUPABASE_INTERNAL_URL || publicUrl;
}

export function getSupabaseAuthCookieName(publicUrl: string): string {
  const hostname = new URL(publicUrl.trim()).hostname;
  return `sb-${hostname.split(".")[0]}-auth-token`;
}

export function shouldEnableVercelAnalytics(): boolean {
  return process.env.VERCEL === "1";
}

export function getAuthRedirectUrl(
  requestUrl: string,
  nextPath: string | null,
  fallbackPath = "/chats/home",
): URL {
  const requestOrigin = new URL(requestUrl).origin;
  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  let redirectOrigin = requestOrigin;

  if (configuredAppUrl) {
    try {
      const configured = new URL(configuredAppUrl);
      if (configured.protocol === "http:" || configured.protocol === "https:") {
        redirectOrigin = configured.origin;
      }
    } catch {
      // A malformed optional public URL must not make auth callbacks fail.
    }
  }

  const fallback = new URL(fallbackPath, `${redirectOrigin}/`);
  if (!nextPath?.startsWith("/") || nextPath.startsWith("//")) {
    return fallback;
  }

  const target = new URL(nextPath, `${redirectOrigin}/`);
  return target.origin === redirectOrigin ? target : fallback;
}
