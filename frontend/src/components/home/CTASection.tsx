"use client";

import { motion } from "framer-motion";
import NeonButton from "@/components/ui/NeonButton";
import { useLanguage } from "@/lib/i18n";
import { cta } from "@/lib/i18n/translations/home";

export default function CTASection() {
  const locale = useLanguage();
  const t = cta[locale];

  return (
    <section className="px-6 py-24">
      <motion.div
        className="mx-auto max-w-3xl rounded-2xl border border-glass-border bg-glass-bg p-12 text-center backdrop-blur-xl"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-50px" }}
        transition={{ duration: 0.7 }}
      >
        <h2 className="text-3xl font-bold md:text-4xl">
          {t.headingStart}
          <span className="text-neon-green">{t.headingHighlight}</span>
          {t.headingEnd}
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-text-secondary">
          {t.description}
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <NeonButton href="/protocol" variant="cyan">
            {t.protocolSpec}
          </NeonButton>
          <NeonButton href="/security" variant="green">
            {t.securityModel}
          </NeonButton>
        </div>
      </motion.div>
    </section>
  );
}
