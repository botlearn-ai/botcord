"use client";

import LinkButton from "@/components/ui/LinkButton";
import Tabs from "@/components/ui/Tabs";
import IconButton from "@/components/ui/IconButton";
import { Menu as MenuIcon } from "lucide-react";
import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useLanguage } from "@/lib/i18n";
import { nav, navLinks } from "@/lib/i18n/translations/common";
import { useAppStore } from "@/store/useAppStore";
import BrandMark from "@/components/ui/BrandMark";

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
    <nav className="fixed top-0 z-50 w-full border-b border-border bg-bg">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.03em] text-[var(--bc-text)]">
          <BrandMark className="h-7 w-7" />
          <span>BotCord</span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={clsx(
                "text-sm font-medium transition-colors duration-200",
                pathname === link.href
                  ? "text-[var(--bc-accent-text)]"
                  : "text-[var(--bc-text-secondary)] hover:text-[var(--bc-text)]"
              )} >
              {navT[link.key]}
            </Link>
          ))}
          <a
            href="https://botlearn.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-[var(--bc-text-secondary)] transition-colors duration-[140ms] hover:text-[var(--bc-text)]" >
            botlearn
          </a>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-4">
          <Tabs value={locale} onValueChange={(value) => setLanguage(value as "en" | "zh")} ariaLabel="Language" size="sm" items={[{ value: "en", label: "EN" }, { value: "zh", label: "中" }]} />

          <a
            href="https://github.com/botlearn-ai/botcord"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden text-[var(--bc-text-secondary)] transition-colors duration-[140ms] hover:text-[var(--bc-text)] sm:block"
            aria-label="GitHub" >
            <svg
              className="h-5 w-5"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true" >
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                clipRule="evenodd"
              />
            </svg>
          </a>

          <IconButton label="Toggle menu" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} className="md:hidden"><MenuIcon strokeWidth={1.75} /></IconButton>
        </div>
      </div>

      {menuOpen && (
        <div className="border-t border-[var(--bc-border)] bg-[var(--bc-bg)] md:hidden">
          <div className="flex flex-col gap-1 px-6 py-4">
            <LinkButton href="https://github.com/botlearn-ai/botcord" target="_blank" rel="noopener noreferrer" variant="row">GitHub</LinkButton>
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={clsx(
                  "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                  pathname === link.href
                    ? "bg-[var(--bc-accent-soft)] text-[var(--bc-accent-text)]"
                    : "text-[var(--bc-text-secondary)] hover:bg-[var(--bc-surface-sunken)] hover:text-[var(--bc-text)]"
                )} >
                {navT[link.key]}
              </Link>
            ))}
            <LinkButton variant="ghost"
              href="https://botlearn.ai"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenuOpen(false)}
               >
              botlearn
            </LinkButton>
          </div>
        </div>
      )}
    </nav>
  );
}
