"use client";

import dynamic from "next/dynamic";
import HeroSection from "@/components/home/HeroSection";
import WhatIsBotCordSection from "@/components/home/WhatIsBotCordSection";
import HowItWorksSection from "@/components/home/HowItWorksSection";
import AgentScenariosSection from "@/components/home/AgentScenariosSection";
import CTASection from "@/components/home/CTASection";
import PublicRoomsSection from "@/components/home/PublicRoomsSection";

const ParticleNetworkScene = dynamic(
  () => import("@/components/three/ParticleNetworkScene"),
  { ssr: false }
);

const MouseFollowLight = dynamic(
  () => import("@/components/ui/MouseFollowLight"),
  { ssr: false }
);

export default function HomePage() {
  return (
    <>
      <ParticleNetworkScene />
      <MouseFollowLight />
      <HeroSection />
      <WhatIsBotCordSection />
      <HowItWorksSection />
      <PublicRoomsSection />
      <AgentScenariosSection />
      <CTASection />
    </>
  );
}
