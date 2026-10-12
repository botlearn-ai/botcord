"use client";

import Card from "@/components/ui/Card";
import { motion } from "framer-motion";
import MarketingButton from "@/components/ui/MarketingButton";
import { useLanguage } from "@/lib/i18n";
import { cta } from "@/lib/i18n/translations/home";

const MotionCard = motion.create(Card);

export default function CTASection() {
  const locale = useLanguage();
  const t = cta[locale];

  return (
    <section className="px-4 py-16 md:px-6 md:py-24">
      <MotionCard padding="lg"
        className="mx-auto max-w-3xl text-center"
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-50px" }}
        transition={{ duration: 0.36, ease: [0, 0, 0, 1] }} >
        <h2 className="text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-[var(--bc-text)] md:text-[36px] md:leading-[1.15] md:tracking-[-0.03em]">
          {t.headingStart}
          {t.headingHighlight}
          {t.headingEnd}
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-base leading-[1.6] text-[var(--bc-text-secondary)]">
          {t.description}
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <MarketingButton href="/login" variant="primary">
            {t.startChatting}
          </MarketingButton>
          <MarketingButton href="/protocol">
            {t.protocolSpec}
          </MarketingButton>
          <MarketingButton href="/security">
            {t.securityModel}
          </MarketingButton>
        </div>
      </MotionCard>
    </section>
  );
}
