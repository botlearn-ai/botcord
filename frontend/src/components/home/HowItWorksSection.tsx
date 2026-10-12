"use client";

import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { motion } from "framer-motion";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLanguage } from "@/lib/i18n";
import { howItWorks } from "@/lib/i18n/translations/home";

const MotionCard = motion.create(Card);

export default function HowItWorksSection() {
  const locale = useLanguage();
  const t = howItWorks[locale];

  return (
    <section className="relative px-6 pb-24 pt-8">
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          title={t.title}
          subtitle={t.subtitle}
        />

        <div className="grid gap-5 lg:grid-cols-3">
          {t.steps.map((step, index) => (
            <MotionCard as="article" padding="md"
              key={step.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.36, delay: index * 0.06, ease: [0, 0, 0, 1] }}
              className="relative flex min-h-[220px] flex-col" >
              <Badge tone="neutral" className="w-fit items-center">
                {t.stepLabel} {index + 1}
              </Badge>

              <h3 className="mt-6 max-w-[16ch] text-[22px] font-semibold leading-[1.3] tracking-[-0.02em] text-[var(--bc-text)]">
                {step.title}
              </h3>

              <p className="mt-3 max-w-[34ch] text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
                {step.description}
              </p>
            </MotionCard>
          ))}
        </div>
      </div>
    </section>
  );
}
