"use client";

import HeroSection from "@/components/home/HeroSection";
import HowItWorksSection from "@/components/home/HowItWorksSection";
import AgentScenariosSection from "@/components/home/AgentScenariosSection";
import CTASection from "@/components/home/CTASection";
import PublicRoomsSection from "@/components/home/PublicRoomsSection";

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <HowItWorksSection />
      <PublicRoomsSection />
      <AgentScenariosSection />
      <CTASection />
    </>
  );
}
