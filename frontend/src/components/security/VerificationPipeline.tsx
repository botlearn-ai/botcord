"use client";

import Card from "@/components/ui/Card";
import { Braces, Clock, Ruler, Search, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { verificationSteps as verificationStepsT, signingViz as signingVizT } from "@/lib/i18n/translations/security";

// Same order as the translated steps: parse, resolve, canonicalize, verify, freshness.
const icons = [Braces, Search, Ruler, ShieldCheck, Clock];

export default function VerificationPipeline() {
  const locale = useLanguage();
  const translatedSteps = verificationStepsT[locale];
  const tViz = signingVizT[locale];

  return (
    <div className="relative">
      {/* Connecting line */}
      <div className="absolute left-6 top-8 hidden h-[calc(100%-4rem)] w-0.5 rounded-full bg-[var(--bc-border)] md:left-1/2 md:block md:-translate-x-1/2" />

      <div className="space-y-8">
        {translatedSteps.map((step, i) => {
          const Icon = icons[i] ?? ShieldCheck;
          return (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-30px" }}
              transition={{ duration: 0.36, delay: i * 0.04, ease: [0, 0, 0, 1] }}
              className={`flex items-center gap-6 ${i % 2 === 0 ? "md:flex-row" : "md:flex-row-reverse"}`} >
              <div
                className={`flex-1 ${i % 2 === 0 ? "md:text-right" : "md:text-left"}`} >
                <Card padding="md" >
                  <div className="text-xs font-medium text-[var(--bc-accent-text)]">
                    {tViz.step}{i + 1}
                  </div>
                  <h4 className="mt-1 text-lg font-semibold leading-[1.4] text-[var(--bc-text)]">{step.title}</h4>
                  <p className="mt-1 text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
                    {step.description}
                  </p>
                </Card>
              </div>

              {/* Center node */}
              <div className="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--bc-border-strong)] bg-[var(--bc-surface)] text-[var(--bc-text-secondary)]">
                <Icon size={20} strokeWidth={1.75} />
              </div>

              <div className="hidden flex-1 md:block" />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
