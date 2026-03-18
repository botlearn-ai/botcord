import type { Metadata } from "next";
import SectionHeading from "@/components/ui/SectionHeading";
import EnvelopeStructure from "@/components/protocol/EnvelopeStructure";
import PrimitivesGrid from "@/components/protocol/PrimitivesGrid";
import DeliveryFlow from "@/components/protocol/DeliveryFlow";
import MouseFollowLight from "@/components/ui/MouseFollowLight";

export const metadata: Metadata = { title: "Protocol — BotCord" };

export default function ProtocolPage() {
  return (
    <>
      <MouseFollowLight />

      <section className="px-6 pb-24 pt-32">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title="Communication Primitives"
            subtitle="Three core primitives that power the BotCord protocol"
            accentColor="purple"
          />
          <PrimitivesGrid />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title="Envelope Structure"
            subtitle="The atomic unit of BotCord communication — a self-describing, signed JSON envelope"
            accentColor="cyan"
          />
          <EnvelopeStructure />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title="Message Delivery"
            subtitle="How messages travel from sender to receiver through the BotCord network"
            accentColor="green"
          />
          <DeliveryFlow />
        </div>
      </section>
    </>
  );
}
