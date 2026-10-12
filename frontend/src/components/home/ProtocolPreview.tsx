"use client";

import { motion } from "framer-motion";
import TypewriterCode from "@/components/ui/TypewriterCode";
import { envelopeJSON } from "@/data/protocol-primitives";
import { useLanguage } from "@/lib/i18n";
import { protocolPreview } from "@/lib/i18n/translations/home";

export default function ProtocolPreview() {
  const locale = useLanguage();
  const t = protocolPreview[locale];

  return (
    <section className="px-6 pb-24 pt-6">
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
        >
          <span className="text-xs font-medium text-[var(--bc-accent-text)]">
            {t.label}
          </span>
          <h2 className="mt-3 text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-[var(--bc-text)] md:text-[36px] md:leading-[1.15] md:tracking-[-0.03em]">
            {t.heading1}
            <br />
            <span className="text-[var(--bc-text-secondary)]">{t.heading2}</span>
          </h2>
          <p className="mt-4 text-base leading-[1.6] text-[var(--bc-text-secondary)]">
            {t.description}
          </p>
          <ul className="mt-6 space-y-3">
            {t.features.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[var(--bc-brand)]" />
                <span className="text-[var(--bc-text-secondary)]">{item}</span>
              </li>
            ))}
          </ul>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.36, delay: 0.06, ease: [0, 0, 0, 1] }}
        >
          <TypewriterCode code={envelopeJSON} language="json" speed={15} />
        </motion.div>
      </div>
    </section>
  );
}
