"use client";

import { motion } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { philosophy } from "@/lib/i18n/translations/vision";

export default function PhilosophySection() {
  const locale = useLanguage();
  const t = philosophy[locale];

  return (
    <div className="space-y-4">
      {/* Header row — desktop only; on mobile each card is labelled inline */}
      <div className="hidden grid-cols-2 gap-4 px-4 text-sm font-semibold md:grid">
        <span className="text-[var(--bc-text-secondary)]">{t.traditional}</span>
        <span className="text-[var(--bc-accent-text)]">{t.botcordWay}</span>
      </div>

      {t.comparisons.map((item, i) => (
        <div key={i} className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-30px" }}
            transition={{ duration: 0.36, delay: i * 0.04, ease: [0, 0, 0, 1] }}
            className="rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface-sunken)] p-4"
          >
            <p className="mb-1 text-xs font-medium text-[var(--bc-text-tertiary)] md:hidden">{t.traditional}</p>
            <p className="text-sm leading-[1.6] text-[var(--bc-text-secondary)]">{item[0]}</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-30px" }}
            transition={{ duration: 0.36, delay: i * 0.04 + 0.04, ease: [0, 0, 0, 1] }}
            className="rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface)] p-4 shadow-[var(--bc-shadow-sm)]"
          >
            <p className="mb-1 text-xs font-medium text-[var(--bc-accent-text)] md:hidden">{t.botcordWay}</p>
            <p className="text-sm leading-[1.6] text-[var(--bc-text)]">{item[1]}</p>
          </motion.div>
        </div>
      ))}
    </div>
  );
}
