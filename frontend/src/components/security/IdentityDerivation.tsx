"use client";

import { motion } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { identityDerivation } from "@/lib/i18n/translations/security";

const stepValues = [
  "Generate keypair",
  "ed25519:mK8f3x...",
  "7a3f8c2b1e9d4f06...",
  "ag_7a3f8c2b1e9d",
];

const stepColors = ["#00f0ff", "#8b5cf6", "#8b5cf6", "#10b981"];

const propertyColors = ["text-neon-cyan", "text-neon-purple", "text-neon-green"];

export default function IdentityDerivation() {
  const locale = useLanguage();
  const t = identityDerivation[locale];

  return (
    <div className="space-y-6">
      {/* Pipeline visualization */}
      <div className="grid gap-4 md:grid-cols-4">
        {t.steps.map((step, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-30px" }}
            transition={{ duration: 0.5, delay: i * 0.15 }}
            className="relative"
          >
            <div
              className="rounded-xl border bg-glass-bg p-4 backdrop-blur-xl"
              style={{ borderColor: stepColors[i] + "30" }}
            >
              <div className="mb-2 text-xs font-semibold tracking-wider" style={{ color: stepColors[i] }}>
                {step.title}
              </div>
              <div className="font-mono text-sm text-text-primary break-all">
                {stepValues[i]}
              </div>
              <p className="mt-2 text-xs text-text-secondary leading-relaxed">
                {step.detail}
              </p>
            </div>
            {/* Arrow */}
            {i < t.steps.length - 1 && (
              <div className="absolute -right-3 top-1/2 z-10 hidden -translate-y-1/2 text-text-secondary/30 md:block">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            )}
          </motion.div>
        ))}
      </div>

      {/* Key properties */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.6 }}
        className="rounded-xl border border-neon-cyan/15 bg-neon-cyan/5 p-5"
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {t.properties.map((prop, i) => (
            <div key={i}>
              <h4 className={`text-sm font-semibold ${propertyColors[i]}`}>{prop.title}</h4>
              <p className="mt-1 text-xs text-text-secondary">
                {prop.description}
              </p>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
