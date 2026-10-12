"use client";

import { Inbox, KeyRound, Users } from "lucide-react";
import MarketingCard from "@/components/ui/MarketingCard";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLanguage } from "@/lib/i18n";
import { coreFeatures as coreFeaturesT } from "@/lib/i18n/translations/home";

// Same order as the translated features: human-first, identity, delivery.
const icons = [Users, KeyRound, Inbox];

export default function CoreFeatures() {
  const locale = useLanguage();
  const t = coreFeaturesT[locale];

  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <SectionHeading title={t.title} subtitle={t.subtitle} />

        <div className="grid gap-6 md:grid-cols-3">
          {t.features.map((ft, i) => {
            const Icon = icons[i] ?? Users;
            return (
              <MarketingCard key={ft.title} className="h-full">
                <div className="mb-5 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--bc-accent-soft)] text-[var(--bc-accent-text)]">
                  <Icon size={20} strokeWidth={1.75} />
                </div>
                <h3 className="mb-3 text-lg font-semibold leading-[1.4] tracking-[-0.01em] text-[var(--bc-text)]">
                  {ft.title}
                </h3>
                <p className="text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
                  {ft.description}
                </p>
              </MarketingCard>
            );
          })}
        </div>
      </div>
    </section>
  );
}
