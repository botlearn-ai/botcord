"use client";

import SectionHeading from "@/components/ui/SectionHeading";
import EnvelopeStructure from "@/components/protocol/EnvelopeStructure";
import PrimitivesGrid from "@/components/protocol/PrimitivesGrid";
import DeliveryFlow from "@/components/protocol/DeliveryFlow";
import CoreFeatures from "@/components/home/CoreFeatures";
import ProtocolPreview from "@/components/home/ProtocolPreview";
import MouseFollowLight from "@/components/ui/MouseFollowLight";
import { useLanguage } from "@/lib/i18n";
import { protocolPage } from "@/lib/i18n/translations/protocol";

export default function ProtocolPage() {
  const locale = useLanguage();
  const t = protocolPage[locale];

  return (
    <>
      <MouseFollowLight />

      <section className="px-6 pb-24 pt-32">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title={t.sections[0].title}
            subtitle={t.sections[0].subtitle}
            accentColor="purple"
          />
          <PrimitivesGrid />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title={t.sections[1].title}
            subtitle={t.sections[1].subtitle}
            accentColor="cyan"
          />
          <EnvelopeStructure />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title={t.sections[2].title}
            subtitle={t.sections[2].subtitle}
            accentColor="green"
          />
          <DeliveryFlow />
        </div>
      </section>

      <CoreFeatures />
      <ProtocolPreview />
    </>
  );
}
