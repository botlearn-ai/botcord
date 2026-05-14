/**
 * [INPUT]: 读取 NEXT_PUBLIC_GA_ID 环境变量，依赖 next/script 注入 gtag.js
 * [OUTPUT]: 向 <head> 注入 GA4 脚本并暴露 window.gtag；监听 App Router 路由变化触发 page_view
 * [POS]: 由 RootLayout 装载的全局组件；ID 缺失时整组件渲染为 null（生产保险丝）
 */

"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

function RouteChangeTracker({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (typeof window.gtag !== "function") return;
    const query = searchParams?.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    window.gtag("config", measurementId, { page_path: url });
  }, [pathname, searchParams, measurementId]);

  return null;
}

export function GoogleAnalytics(): ReactNode {
  if (!GA_ID) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          gtag('config', '${GA_ID}', { send_page_view: false });
        `}
      </Script>
      <Suspense fallback={null}>
        <RouteChangeTracker measurementId={GA_ID} />
      </Suspense>
    </>
  );
}
