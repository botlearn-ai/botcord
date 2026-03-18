"use client";

import { motion } from "framer-motion";
import { verificationSteps } from "@/data/security-features";
import { useLanguage } from "@/lib/i18n";
import { verificationSteps as verificationStepsT, signingViz as signingVizT } from "@/lib/i18n/translations/security";

export default function VerificationPipeline() {
  const locale = useLanguage();
  const translatedSteps = verificationStepsT[locale];
  const tViz = signingVizT[locale];

  return (
    <div className="relative">
      {/* Connecting line */}
      <div className="absolute left-6 top-8 hidden h-[calc(100%-4rem)] w-px bg-gradient-to-b from-neon-cyan via-neon-purple to-neon-green md:left-1/2 md:block" />

      <div className="space-y-8">
        {verificationSteps.map((step, i) => (
          <motion.div
            key={step.step}
            initial={{ opacity: 0, x: i % 2 === 0 ? -30 : 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-30px" }}
            transition={{ duration: 0.5, delay: i * 0.1 }}
            className={`flex items-center gap-6 ${i % 2 === 0 ? "md:flex-row" : "md:flex-row-reverse"}`}
          >
            <div
              className={`flex-1 ${i % 2 === 0 ? "md:text-right" : "md:text-left"}`}
            >
              <div className="rounded-xl border border-glass-border bg-glass-bg p-4 backdrop-blur-xl">
                <div className="text-xs font-medium text-neon-cyan">
                  {tViz.step}{step.step}
                </div>
                <h4 className="mt-1 text-lg font-semibold">{translatedSteps[i].title}</h4>
                <p className="mt-1 text-sm text-text-secondary">
                  {translatedSteps[i].description}
                </p>
              </div>
            </div>

            {/* Center node */}
            <div className="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-neon-cyan/30 bg-deep-black text-xl">
              {step.icon}
            </div>

            <div className="hidden flex-1 md:block" />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
