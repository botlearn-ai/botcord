"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useLanguage } from "@/lib/i18n";
import { nav, navLinks } from "@/lib/i18n/translations/common";
import { useAppStore } from "@/store/useAppStore";

export default function Navbar() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const locale = useLanguage();
  const navT = nav[locale];
  const { setLanguage } = useAppStore();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let stored: string | null = null;
    try { stored = localStorage.getItem('app-storage'); } catch { /* */ }
    if (!stored) {
      const browserLang = navigator.language.toLowerCase();
      const detected: 'en' | 'zh' = browserLang.startsWith('zh') ? 'zh' : 'en';
      setLanguage(detected);
    }
  }, []);

  return (
    <nav className="fixed top-0 z-50 w-full border-b border-glass-border bg-deep-black/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold">
          <img src="/logo.svg" alt="BotCord" className="h-8 w-8" />
          <span className="text-text-primary">BotCord</span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={clsx(
                "text-sm font-medium transition-colors duration-200",
                pathname === link.href
                  ? "text-neon-cyan"
                  : "text-text-secondary hover:text-neon-cyan"
              )}
            >
              {navT[link.key]}
            </Link>
          ))}
          <a
            href="https://botlearn.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-text-secondary transition-colors duration-200 hover:text-neon-cyan"
          >
            botlearn
          </a>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1 text-xs">
            <button
              onClick={() => setLanguage('en')}
              className={clsx(
                "px-1.5 py-0.5 rounded transition-colors",
                locale === 'en' ? "text-neon-cyan" : "text-text-secondary hover:text-text-primary"
              )}
            >
              EN
            </button>
            <span className="text-text-secondary/40">&middot;</span>
            <button
              onClick={() => setLanguage('zh')}
              className={clsx(
                "px-1.5 py-0.5 rounded transition-colors",
                locale === 'zh' ? "text-neon-cyan" : "text-text-secondary hover:text-text-primary"
              )}
            >
              中
            </button>
          </div>

          <a
            href="https://github.com/botlearn-ai/botcord"
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-secondary transition-colors duration-200 hover:text-neon-cyan"
            aria-label="GitHub"
          >
            <svg
              className="h-5 w-5"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                clipRule="evenodd"
              />
            </svg>
          </a>

          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center justify-center rounded-lg p-2 text-text-secondary hover:text-neon-cyan md:hidden"
            aria-label="Toggle menu"
          >
            <svg
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="border-t border-glass-border bg-deep-black/90 backdrop-blur-xl md:hidden">
          <div className="flex flex-col gap-1 px-6 py-4">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={clsx(
                  "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                  pathname === link.href
                    ? "bg-neon-cyan-dim text-neon-cyan"
                    : "text-text-secondary hover:bg-glass-bg hover:text-neon-cyan"
                )}
              >
                {navT[link.key]}
              </Link>
            ))}
            <a
              href="https://botlearn.ai"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenuOpen(false)}
              className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-neon-cyan"
            >
              botlearn
            </a>
          </div>
        </div>
      )}
    </nav>
  );
}
