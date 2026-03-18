"use client";

import dynamic from "next/dynamic";
import HeroSection from "@/components/home/HeroSection";
import ConversationDemo from "@/components/home/ConversationDemo";
import CoreFeatures from "@/components/home/CoreFeatures";
import ProtocolPreview from "@/components/home/ProtocolPreview";
import CTASection from "@/components/home/CTASection";

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
      <ConversationDemo />
      <CoreFeatures />
      <ProtocolPreview />
      <CTASection />
    </>
  );
}
