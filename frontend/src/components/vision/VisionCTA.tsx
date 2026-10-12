"use client";

import { motion } from "framer-motion";
import MarketingButton from "@/components/ui/MarketingButton";
import { useLanguage } from "@/lib/i18n";
import { visionCta } from "@/lib/i18n/translations/vision";

export default function VisionCTA() {
  const locale = useLanguage();
  const t = visionCta[locale];

  return (
    <section className="px-6 py-24">
      <motion.div
        className="mx-auto max-w-3xl text-center"
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
      >
        <h2 className="text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-[var(--bc-text)] md:text-[36px] md:leading-[1.15] md:tracking-[-0.03em]">
          {t.headingStart}
          {t.headingHighlight}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-[1.6] text-[var(--bc-text-secondary)]">
          {t.description}
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <MarketingButton href="/protocol" variant="primary">
            {t.readSpec}
          </MarketingButton>
          <MarketingButton href="/security">
            {t.securityModel}
          </MarketingButton>
          <MarketingButton href="/">
            {t.backHome}
          </MarketingButton>
        </div>
      </motion.div>
    </section>
  );
}
