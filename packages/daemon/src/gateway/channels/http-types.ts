/**
 * Canonical `fetch`-compatible signature shared by gateway-control.ts and
 * the WeChat HTTP helpers. Lets tests inject a stub without depending on
 * undici's full type surface.
 *
 * Kept structurally compatible with both `globalThis.fetch` and the
 * narrower wechat-http test stubs — `body` is optional so callers that
 * only issue GETs (e.g. Telegram `getMe` test probe) can omit it.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status?: number;
  ok?: boolean;
  text(): Promise<string>;
}>;
