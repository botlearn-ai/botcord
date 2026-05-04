/**
 * Split a long message into chunks <= `limit` characters each. Prefers to cut
 * on newline boundaries so multi-paragraph replies don't fragment mid-line.
 *
 * Shared by third-party channel adapters (Telegram, WeChat) which both have a
 * per-message size cap from upstream and no native streaming. WeChat caller
 * passes a smaller `limit` (~1800), Telegram a larger one (~4000, since the
 * raw Telegram limit is 4096).
 *
 * Empty input returns `[""]` so callers can iterate uniformly without a length
 * check.
 */
export function splitText(text: string, limit: number): string[] {
  if (limit <= 0) return [text];
  if (text.length === 0) return [""];
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    out.push(remaining.slice(0, cut));
    // Drop the leading newline so the next chunk doesn't start with a blank line.
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}
