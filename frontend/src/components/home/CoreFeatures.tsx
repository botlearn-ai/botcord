"use client";

import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import SectionHeading from "@/components/ui/SectionHeading";
import { coreFeatures } from "@/data/features";
import { useLanguage } from "@/lib/i18n";
import { coreFeatures as coreFeaturesT } from "@/lib/i18n/translations/home";

export default function CoreFeatures() {
  const locale = useLanguage();
  const t = coreFeaturesT[locale];

  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          title={t.title}
          subtitle={t.subtitle}
          accentColor="cyan"
        />

        <div className="grid gap-6 md:grid-cols-3">
          {coreFeatures.map((feature, i) => {
            const ft = t.features[i];
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.6, delay: i * 0.15 }}
              >
                <GlassCard glowColor={feature.color} className="h-full">
                  <div className="mb-4 text-4xl">{feature.icon}</div>
                  <h3 className="mb-3 text-xl font-semibold">{ft.title}</h3>
                  <p className="text-sm leading-relaxed text-text-secondary">
                    {ft.description}
                  </p>
                </GlassCard>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
