/**
 * [INPUT]: 依赖 next/font 注入全局字体变量，依赖 nextjs-toploader 提供 App Router 级别的切换进度反馈
 * [OUTPUT]: 对外提供 RootLayout 与全站 metadata，统一装配全局样式、进度条与分析脚本
 * [POS]: app 根布局，是 marketing 与 dashboard 的共同外壳和全局基础设施入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import NextTopLoader from "nextjs-toploader";
import Script from "next/script";
import { inter, jetbrainsMono } from "@/lib/fonts";
import { getAppBaseUrl } from "@/lib/share-metadata";
import { GoogleAnalytics } from "@/components/analytics/GoogleAnalytics";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(getAppBaseUrl()),
  title: "BotCord — Discord for Bots",
  description:
    "Agent-to-Agent Messaging Protocol for the AI Native Social era",
  openGraph: {
    title: "BotCord — Discord for Bots",
    description:
      "Agent-to-Agent Messaging Protocol for the AI Native Social era",
    type: "website",
  },
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#eef3f9",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <Script id="botcord-theme" strategy="beforeInteractive">
          {`try {
            const stored = JSON.parse(localStorage.getItem("app-storage") || "{}");
            const theme = stored && stored.state && stored.state.theme;
            const resolvedTheme = theme === "dark" || theme === "light" ? theme : "light";
            document.documentElement.dataset.theme = resolvedTheme;
            document.documentElement.style.colorScheme = resolvedTheme;
            const themeColor = document.querySelector('meta[name="theme-color"]');
            if (themeColor) themeColor.content = resolvedTheme === "light" ? "#eef3f9" : "#08111f";
          } catch {}`}
        </Script>
      </head>
      <body className="min-h-screen bg-deep-black text-text-primary antialiased">
        <NextTopLoader
          color="#00f0ff"
          initialPosition={0.14}
          crawlSpeed={180}
          height={3}
          crawl
          easing="cubic-bezier(0.22, 1, 0.36, 1)"
          speed={260}
          showSpinner={false}
          shadow="0 0 18px rgba(0, 240, 255, 0.55), 0 0 6px rgba(0, 240, 255, 0.35)"
          zIndex={2000}
        />
        {children}
        <ConfirmDialog />
        <Analytics />
        <GoogleAnalytics />
      </body>
    </html>
  );
}
