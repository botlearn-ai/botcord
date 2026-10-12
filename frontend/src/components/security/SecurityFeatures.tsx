"use client";

import MarketingCard from "@/components/ui/MarketingCard";
import { useLanguage } from "@/lib/i18n";
import { securityFeatures as securityFeaturesT } from "@/lib/i18n/translations/security";

export default function SecurityFeatures() {
  const locale = useLanguage();
  const translatedFeatures = securityFeaturesT[locale];

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {translatedFeatures.map((feature, i) => (
        <MarketingCard key={i} className="h-full">
          <h3 className="mb-2 text-lg font-semibold leading-[1.4] tracking-[-0.01em] text-[var(--bc-text)]">
            {feature.title}
          </h3>
          <p className="text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
            {feature.description}
          </p>
        </MarketingCard>
      ))}
    </div>
  );
}
