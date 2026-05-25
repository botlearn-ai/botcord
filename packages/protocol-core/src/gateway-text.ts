/**
 * Shared text helpers used by gateway channel/provider adapters.
 *
 * Lifted from `packages/daemon/src/gateway/channels/text-split.ts` so both
 * the daemon channel adapters (Telegram, WeChat, Feishu) and the
 * `gateway-ingress` provider adapters (telegram, future Discord, …) use
 * one canonical implementation instead of copy-pasting.
 */

/**
 * Split a long message into chunks <= `limit` characters each. Prefers to cut
 * on newline boundaries so multi-paragraph replies don't fragment mid-line.
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
