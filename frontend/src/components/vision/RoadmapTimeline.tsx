"use client";

import Card from "@/components/ui/Card";
import { motion } from "framer-motion";
import { milestones } from "@/data/roadmap";
import { useLanguage } from "@/lib/i18n";
import { roadmap as roadmapT } from "@/lib/i18n/translations/vision";

const statusColors = {
  completed: "var(--bc-success)",
  active: "var(--bc-brand)",
  planned: "var(--bc-text-tertiary)",
};

export default function RoadmapTimeline() {
  const locale = useLanguage();
  const t = roadmapT[locale];

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-6 top-0 h-full w-0.5 -translate-x-1/2 rounded-full bg-[var(--bc-border)] md:left-1/2" />

      <div className="space-y-12">
        {milestones.map((ms, i) => {
          const color = statusColors[ms.status];
          const isLeft = i % 2 === 0;

          return (
            <motion.div
              key={ms.id}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.36, delay: i * 0.03, ease: [0, 0, 0, 1] }}
              className={`flex items-start gap-6 ${isLeft ? "md:flex-row" : "md:flex-row-reverse"}`} >
              <div
                className={`hidden flex-1 md:block ${isLeft ? "text-right" : "text-left"}`} >
                <Card padding="md" className="inline-block">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs font-medium text-[var(--bc-text-secondary)]">
                      {t.statusLabels[ms.status]}
                    </span>
                  </div>
                  <h4 className="mt-1 font-semibold text-[var(--bc-text)]">
                    <span className="font-mono text-sm text-[var(--bc-text-secondary)]">
                      {ms.id}
                    </span>{" "}
                    {t.milestones[i].title}
                  </h4>
                  <p className="mt-1 text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
                    {t.milestones[i].description}
                  </p>
                </Card>
              </div>

              {/* Center node */}
              <div
                className="relative z-10 mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 bg-[var(--bc-bg)] font-mono text-xs font-semibold text-[var(--bc-text)]"
                style={{ borderColor: color }} >
                {ms.id}
              </div>

              {/* Mobile card */}
              <div className="flex-1 md:hidden">
                <Card padding="md" >
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs font-medium text-[var(--bc-text-secondary)]">
                      {t.statusLabels[ms.status]}
                    </span>
                  </div>
                  <h4 className="mt-1 font-semibold text-[var(--bc-text)]">{t.milestones[i].title}</h4>
                  <p className="mt-1 text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
                    {t.milestones[i].description}
                  </p>
                </Card>
              </div>

              <div className="hidden flex-1 md:block" />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
