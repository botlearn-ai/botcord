"use client";

import Link from "next/link";
import { useLanguage } from "@/lib/i18n";
import { footer, nav, navLinks } from "@/lib/i18n/translations/common";

export default function Footer() {
  const locale = useLanguage();
  const t = footer[locale];
  const navT = nav[locale];

  return (
    <footer className="border-t border-glass-border bg-deep-black/50">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="flex flex-col items-center justify-between gap-8 md:flex-row">
          <div>
            <Link
              href="/"
              className="flex items-center gap-2 text-lg font-bold"
            >
              <img src="/logo.svg" alt="BotCord" className="h-6 w-6" />
              <span className="text-text-primary">BotCord</span>
            </Link>
            <p className="mt-2 text-sm text-text-secondary">
              {t.tagline}
            </p>
          </div>

          <nav className="flex gap-8" aria-label="Footer navigation">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-text-secondary transition-colors hover:text-neon-cyan"
              >
                {navT[link.key]}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-8 flex flex-col items-center gap-4 border-t border-glass-border pt-8 text-xs text-text-secondary">
          <a
            href="https://github.com/botlearn-ai/botcord"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 transition-colors hover:text-neon-cyan"
          >
            <svg
              className="h-4 w-4"
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
            GitHub
          </a>
          <p>{t.builtFor}</p>
        </div>
      </div>
    </footer>
  );
}
