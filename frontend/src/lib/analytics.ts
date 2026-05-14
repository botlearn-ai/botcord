/**
 * [INPUT]: 依赖 window.gtag 全局函数（由 GoogleAnalytics 组件注入）
 * [OUTPUT]: 暴露 trackEvent / trackPageView 等帮助函数，供业务组件埋点
 * [POS]: 全站统一的 GA4 事件埋点入口；未配置 NEXT_PUBLIC_GA_ID 时所有函数为 no-op
 */

declare global {
  interface Window {
    gtag?: (
      command: "config" | "event" | "set" | "consent" | "js",
      targetId: string | Date,
      params?: Record<string, unknown>,
    ) => void;
    dataLayer?: unknown[];
  }
}

export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_ID ?? "";

export const isGAEnabled = (): boolean =>
  typeof window !== "undefined" &&
  GA_MEASUREMENT_ID.length > 0 &&
  typeof window.gtag === "function";

export function trackPageView(url: string): void {
  if (!isGAEnabled()) return;
  window.gtag!("config", GA_MEASUREMENT_ID, {
    page_path: url,
  });
}

export function trackEvent(
  action: string,
  params: Record<string, unknown> = {},
): void {
  if (!isGAEnabled()) return;
  window.gtag!("event", action, params);
}

export function setUserId(userId: string | null): void {
  if (!isGAEnabled()) return;
  window.gtag!("set", GA_MEASUREMENT_ID, {
    user_id: userId ?? undefined,
  });
}

export function setUserProperties(props: Record<string, unknown>): void {
  if (!isGAEnabled()) return;
  window.gtag!("set", "user_properties", props);
}
