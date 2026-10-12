"use client";

import Card from "@/components/ui/Card";
import { motion } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { identityDerivation } from "@/lib/i18n/translations/security";

const MotionCard = motion.create(Card);

const stepValues = [
  "Generate keypair",
  "ed25519:mK8f3x...",
  "7a3f8c2b1e9d4f06...",
  "ag_7a3f8c2b1e9d",
];

export default function IdentityDerivation() {
  const locale = useLanguage();
  const t = identityDerivation[locale];

  return (
    <div className="space-y-6">
      {/* Pipeline visualization */}
      <div className="grid gap-4 md:grid-cols-4">
        {t.steps.map((step, i) => {
          const isResult = i === t.steps.length - 1;
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-30px" }}
              transition={{ duration: 0.36, delay: i * 0.06, ease: [0, 0, 0, 1] }}
              className="relative" >
              <div
                className={`h-full rounded-xl border p-4 ${
                  isResult
                    ? "border-[var(--bc-brand)]/40 bg-[var(--bc-accent-soft)]"
                    : "border-[var(--bc-border)] bg-[var(--bc-surface)] shadow-[var(--bc-shadow-sm)]"
                }`} >
                <div className={`mb-2 text-xs font-medium ${isResult ? "text-[var(--bc-accent-text)]" : "text-[var(--bc-text-secondary)]"}`}>
                  {step.title}
                </div>
                <div className="break-all font-mono text-[13px] text-[var(--bc-text)]">
                  {stepValues[i]}
                </div>
                <p className="mt-2 text-xs leading-[1.45] text-[var(--bc-text-secondary)]">
                  {step.detail}
                </p>
              </div>
              {/* Connector to the next step */}
              {i < t.steps.length - 1 && (
                <span
                  className="absolute -right-3 top-1/2 z-10 hidden h-0.5 w-2 -translate-y-1/2 rounded-full bg-[var(--bc-border-strong)] md:block"
                  aria-hidden="true"
                />
              )}
            </motion.div>
          );
        })}
      </div>

      {/* Key properties */}
      <MotionCard padding="md"
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.36, delay: 0.2, ease: [0, 0, 0, 1] }} >
        <div className="grid gap-4 sm:grid-cols-3">
          {t.properties.map((prop, i) => (
            <div key={i}>
              <h4 className="text-sm font-semibold text-[var(--bc-text)]">{prop.title}</h4>
              <p className="mt-1 text-[13px] leading-[1.5] text-[var(--bc-text-secondary)]">
                {prop.description}
              </p>
            </div>
          ))}
        </div>
      </MotionCard>
    </div>
  );
}
