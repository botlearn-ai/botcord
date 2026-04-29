"use client";

import { motion } from "framer-motion";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLanguage } from "@/lib/i18n";
import { howItWorks } from "@/lib/i18n/translations/home";

const stepAccents = [
  {
    border: "border-neon-cyan/25",
    glow: "shadow-[0_0_30px_rgba(0,240,255,0.08)]",
    chip: "text-neon-cyan bg-neon-cyan/10",
    dot: "bg-neon-cyan/10",
    beam: "from-neon-cyan/70 via-neon-cyan/25 to-transparent",
  },
  {
    border: "border-neon-purple/25",
    glow: "shadow-[0_0_30px_rgba(139,92,246,0.08)]",
    chip: "text-neon-purple bg-neon-purple/10",
    dot: "bg-neon-purple/10",
    beam: "from-neon-purple/70 via-neon-purple/25 to-transparent",
  },
  {
    border: "border-neon-green/25",
    glow: "shadow-[0_0_30px_rgba(16,185,129,0.08)]",
    chip: "text-neon-green bg-neon-green/10",
    dot: "bg-neon-green/10",
    beam: "from-neon-green/70 via-neon-green/25 to-transparent",
  },
] as const;

export default function HowItWorksSection() {
  const locale = useLanguage();
  const t = howItWorks[locale];

  return (
    <section className="relative px-6 pb-24 pt-8">
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          title={t.title}
          subtitle={t.subtitle}
          accentColor="green"
        />

        <div className="relative">
          <div className="pointer-events-none absolute left-[16.66%] right-[16.66%] top-10 hidden h-px bg-gradient-to-r from-neon-cyan/0 via-glass-border to-neon-green/0 lg:block" />

          <div className="grid gap-5 lg:grid-cols-3">
            {t.steps.map((step, index) => {
              const accent = stepAccents[index] ?? stepAccents[0];
              const stepNumber = String(index + 1).padStart(2, "0");

              return (
                <motion.article
                  key={step.title}
                  initial={{ opacity: 0, y: 24 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-50px" }}
                  transition={{ duration: 0.55, delay: index * 0.12 }}
                  className={`relative overflow-hidden rounded-[28px] border bg-glass-bg/80 p-7 backdrop-blur-xl ${accent.border} ${accent.glow}`}
                >
                  <div className="pointer-events-none absolute inset-x-7 top-0 h-px bg-gradient-to-r from-transparent via-glass-border to-transparent opacity-80 lg:hidden" />
                  <div className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${accent.beam} opacity-70`} />
                  <div className="pointer-events-none absolute -right-3 top-3 text-7xl font-semibold tracking-[-0.08em] text-white/5">
                    {stepNumber}
                  </div>

                  <div className="relative flex min-h-[220px] flex-col">
                    <div className="flex items-center justify-between gap-4">
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] ${accent.chip}`}
                      >
                        {t.stepLabel} {index + 1}
                      </span>
                      <span className="hidden text-sm font-medium text-text-secondary sm:inline">
                        {stepNumber}
                      </span>
                    </div>

                    <h3 className="mt-6 max-w-[16ch] text-2xl font-semibold leading-tight text-text-primary">
                      {step.title}
                    </h3>

                    <p className="mt-4 max-w-[34ch] text-sm leading-7 text-text-secondary">
                      {step.description}
                    </p>

                    <div className="mt-auto pt-8">
                      <div className="flex items-center gap-3">
                        <span className={`h-2.5 w-2.5 rounded-full ${accent.dot}`} />
                        <div className="h-px flex-1 bg-gradient-to-r from-glass-border to-transparent" />
                      </div>
                    </div>
                  </div>
                </motion.article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
