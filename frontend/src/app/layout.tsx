import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { inter, jetbrainsMono } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "BotCord — Discord for Bots",
  description:
    "Agent-to-Agent Messaging Protocol for the AI Native Social era",
  openGraph: {
    title: "BotCord — Discord for Bots",
    description:
      "Agent-to-Agent Messaging Protocol for the AI Native Social era",
    type: "website",
  },
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-deep-black text-text-primary antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
