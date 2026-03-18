"use client";

import { motion } from "framer-motion";
import { milestones } from "@/data/roadmap";
import { useLanguage } from "@/lib/i18n";
import { roadmap as roadmapT } from "@/lib/i18n/translations/vision";

const statusColors = {
  completed: "#10b981",
  active: "#00f0ff",
  planned: "#8b5cf6",
};

export default function RoadmapTimeline() {
  const locale = useLanguage();
  const t = roadmapT[locale];

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-6 top-0 h-full w-px bg-gradient-to-b from-neon-green via-neon-cyan to-neon-purple md:left-1/2" />

      <div className="space-y-12">
        {milestones.map((ms, i) => {
          const color = statusColors[ms.status];
          const isLeft = i % 2 === 0;

          return (
            <motion.div
              key={ms.id}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.5, delay: i * 0.08 }}
              className={`flex items-start gap-6 ${isLeft ? "md:flex-row" : "md:flex-row-reverse"}`}
            >
              <div
                className={`hidden flex-1 md:block ${isLeft ? "text-right" : "text-left"}`}
              >
                <div className="inline-block rounded-xl border border-glass-border bg-glass-bg p-4 backdrop-blur-xl">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs" style={{ color }}>
                      {t.statusLabels[ms.status]}
                    </span>
                  </div>
                  <h4 className="mt-1 font-semibold">
                    <span style={{ color }} className="font-mono text-sm">
                      {ms.id}
                    </span>{" "}
                    {t.milestones[i].title}
                  </h4>
                  <p className="mt-1 text-sm text-text-secondary">
                    {t.milestones[i].description}
                  </p>
                </div>
              </div>

              {/* Center node */}
              <div
                className="relative z-10 mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 bg-deep-black font-mono text-xs font-bold"
                style={{
                  borderColor: color,
                  color: color,
                  boxShadow: `0 0 12px ${color}40`,
                }}
              >
                {ms.id}
              </div>

              {/* Mobile card */}
              <div className="flex-1 md:hidden">
                <div className="rounded-xl border border-glass-border bg-glass-bg p-4 backdrop-blur-xl">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs" style={{ color }}>
                      {t.statusLabels[ms.status]}
                    </span>
                  </div>
                  <h4 className="mt-1 font-semibold">{t.milestones[i].title}</h4>
                  <p className="mt-1 text-sm text-text-secondary">
                    {t.milestones[i].description}
                  </p>
                </div>
              </div>

              <div className="hidden flex-1 md:block" />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
