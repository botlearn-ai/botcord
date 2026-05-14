/**
 * [INPUT]: 依赖 window.dataLayer 队列（由 GoogleAnalytics 组件在页面早期注入）
 * [OUTPUT]: 暴露 trackEvent / trackPageView 等帮助函数，供业务组件埋点
 * [POS]: 全站统一的 GA4 事件埋点入口；未配置 NEXT_PUBLIC_GA_ID 时所有函数为 no-op
 */

type GtagArgs =
  | ["js", Date]
  | ["config", string, Record<string, unknown>?]
  | ["event", string, Record<string, unknown>?]
  | ["set", Record<string, unknown>]
  | ["set", string, Record<string, unknown>]
  | ["consent", "default" | "update", Record<string, unknown>];

declare global {
  interface Window {
    gtag?: (...args: GtagArgs) => void;
    dataLayer?: unknown[];
  }
}

export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_ID ?? "";

export const isGAEnabled = (): boolean =>
  typeof window !== "undefined" && GA_MEASUREMENT_ID.length > 0;

/**
 * Push directly to dataLayer instead of calling window.gtag, so events
 * fired before gtag.js loads are queued and replayed on load.
 */
function dlPush(args: GtagArgs): void {
  if (!isGAEnabled()) return;
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push(args);
}

export function trackPageView(url: string): void {
  dlPush(["config", GA_MEASUREMENT_ID, { page_path: url }]);
}

export function trackEvent(
  action: string,
  params: Record<string, unknown> = {},
): void {
  dlPush(["event", action, params]);
}

export function setUserId(userId: string | null): void {
  dlPush(["config", GA_MEASUREMENT_ID, { user_id: userId ?? undefined }]);
}

export function setUserProperties(props: Record<string, unknown>): void {
  dlPush(["set", "user_properties", props]);
}
