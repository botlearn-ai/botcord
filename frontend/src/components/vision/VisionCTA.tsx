"use client";

import { motion } from "framer-motion";
import NeonButton from "@/components/ui/NeonButton";
import { useLanguage } from "@/lib/i18n";
import { visionCta } from "@/lib/i18n/translations/vision";

export default function VisionCTA() {
  const locale = useLanguage();
  const t = visionCta[locale];

  return (
    <section className="px-6 py-24">
      <motion.div
        className="mx-auto max-w-3xl text-center"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.7 }}
      >
        <h2 className="text-3xl font-bold md:text-5xl">
          {t.headingStart}
          <span className="bg-gradient-to-r from-neon-cyan via-neon-purple to-neon-green bg-clip-text text-transparent">
            {t.headingHighlight}
          </span>
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-lg text-text-secondary">
          {t.description}
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <NeonButton href="/protocol" variant="cyan">
            {t.readSpec}
          </NeonButton>
          <NeonButton href="/security" variant="purple">
            {t.securityModel}
          </NeonButton>
          <NeonButton href="/" variant="green">
            {t.backHome}
          </NeonButton>
        </div>
      </motion.div>
    </section>
  );
}
