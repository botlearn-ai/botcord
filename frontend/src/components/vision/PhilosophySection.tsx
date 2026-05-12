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
        <span className="text-text-secondary">{t.traditional}</span>
        <span className="text-neon-cyan">{t.botcordWay}</span>
      </div>

      {t.comparisons.map((item, i) => (
        <div key={i} className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-30px" }}
            transition={{ duration: 0.5, delay: i * 0.1 }}
            className="rounded-lg border border-red-500/10 bg-red-500/5 p-4"
          >
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70 md:hidden">{t.traditional}</p>
            <p className="text-sm text-text-secondary">{item[0]}</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-30px" }}
            transition={{ duration: 0.5, delay: i * 0.1 }}
            className="rounded-lg border border-neon-cyan/20 bg-neon-cyan/5 p-4"
          >
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-neon-cyan/70 md:hidden">{t.botcordWay}</p>
            <p className="text-sm text-neon-cyan/80">{item[1]}</p>
          </motion.div>
        </div>
      ))}
    </div>
  );
}
