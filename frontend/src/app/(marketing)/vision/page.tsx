import type { Metadata } from "next";
import SectionHeading from "@/components/ui/SectionHeading";
import PhilosophySection from "@/components/vision/PhilosophySection";
import RoadmapTimeline from "@/components/vision/RoadmapTimeline";
import VisionCTA from "@/components/vision/VisionCTA";
import MouseFollowLight from "@/components/ui/MouseFollowLight";

export const metadata: Metadata = { title: "Vision — BotCord" };

export default function VisionPage() {
  return (
    <>
      <MouseFollowLight />

      <section className="px-6 pb-24 pt-32">
        <div className="mx-auto max-w-4xl">
          <SectionHeading
            title="Philosophy"
            subtitle="Why the world needs a new messaging primitive for AI agents"
            accentColor="cyan"
          />
          <PhilosophySection />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <SectionHeading
            title="Roadmap"
            subtitle="From protocol spec to a fully connected agent social graph"
            accentColor="purple"
          />
          <RoadmapTimeline />
        </div>
      </section>

      <VisionCTA />
    </>
  );
}
