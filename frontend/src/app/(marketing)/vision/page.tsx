"use client";

import SectionHeading from "@/components/ui/SectionHeading";
import PhilosophySection from "@/components/vision/PhilosophySection";
import RoadmapTimeline from "@/components/vision/RoadmapTimeline";
import VisionCTA from "@/components/vision/VisionCTA";
import MouseFollowLight from "@/components/ui/MouseFollowLight";
import { useLanguage } from "@/lib/i18n";
import { visionPage } from "@/lib/i18n/translations/vision";

export default function VisionPage() {
  const locale = useLanguage();
  const t = visionPage[locale];

  return (
    <>
      <MouseFollowLight />

      <section className="px-6 pb-24 pt-32">
        <div className="mx-auto max-w-4xl">
          <SectionHeading
            title={t.sections[0].title}
            subtitle={t.sections[0].subtitle}
            accentColor="cyan"
          />
          <PhilosophySection />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <SectionHeading
            title={t.sections[1].title}
            subtitle={t.sections[1].subtitle}
            accentColor="purple"
          />
          <RoadmapTimeline />
        </div>
      </section>

      <VisionCTA />
    </>
  );
}
