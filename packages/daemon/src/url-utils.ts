/**
 * Append a `next` query param to a URL. Used by the device-code flow to
 * encode a post-auth redirect target into the Hub-issued verification URL,
 * so the dashboard knows where to send the user after they click Authorize.
 *
 * Falls back to returning the original URL string if parsing fails — the
 * device-code flow keeps working, just without the redirect convenience.
 */
export function appendNextParam(url: string, next: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("next", next);
    return u.toString();
  } catch {
    return url;
  }
}
