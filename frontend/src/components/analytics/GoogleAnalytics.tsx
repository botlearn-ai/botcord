/**
 * [INPUT]: 读取 NEXT_PUBLIC_GA_ID 环境变量，依赖 next/script 注入 gtag.js
 * [OUTPUT]: 在 body 末尾挂载 GA4 脚本并暴露 window.dataLayer/gtag；监听 App Router 路由变化触发 page_view
 * [POS]: 由 RootLayout 装载的全局组件；ID 缺失或格式非法时整组件渲染为 null（生产保险丝）
 */

"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { trackPageView } from "@/lib/analytics";

const RAW_GA_ID = process.env.NEXT_PUBLIC_GA_ID;
const GA_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;
const GA_ID = RAW_GA_ID && GA_ID_PATTERN.test(RAW_GA_ID) ? RAW_GA_ID : null;

function RouteChangeTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams?.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    trackPageView(url);
  }, [pathname, searchParams]);

  return null;
}

export function GoogleAnalytics() {
  if (!GA_ID) return null;

  const initScript = `
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', ${JSON.stringify(GA_ID)}, { send_page_view: false });
  `;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`}
        strategy="afterInteractive"
      />
      <Script
        id="ga4-init"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: initScript }}
      />
      <Suspense fallback={null}>
        <RouteChangeTracker />
      </Suspense>
    </>
  );
}
