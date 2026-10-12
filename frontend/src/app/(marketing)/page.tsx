"use client";

import HeroSection from "@/components/home/HeroSection";
import AgentScenariosSection from "@/components/home/AgentScenariosSection";
import PublicRoomsSection from "@/components/home/PublicRoomsSection";
import HowItWorksSection from "@/components/home/HowItWorksSection";
import TrustSection from "@/components/home/TrustSection";
import CTASection from "@/components/home/CTASection";

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <AgentScenariosSection />
      <PublicRoomsSection />
      <HowItWorksSection />
      <TrustSection />
      <CTASection />
    </>
  );
}
