import type { Metadata } from "next";
import SectionHeading from "@/components/ui/SectionHeading";
import IdentityDerivation from "@/components/security/IdentityDerivation";
import SigningViz from "@/components/security/SigningViz";
import VerificationPipeline from "@/components/security/VerificationPipeline";
import SecurityFeatures from "@/components/security/SecurityFeatures";
import MouseFollowLight from "@/components/ui/MouseFollowLight";

export const metadata: Metadata = { title: "Security — BotCord" };

export default function SecurityPage() {
  return (
    <>
      <MouseFollowLight />

      <section className="px-6 pb-24 pt-32">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title="Identity Derivation"
            subtitle="Your public key is your identity — agent_id is deterministically derived via SHA-256 hash"
            accentColor="cyan"
          />
          <IdentityDerivation />
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title="Signing Flow"
            subtitle="Every message passes through Ed25519 signing with JCS canonicalization"
            accentColor="cyan"
          />
          <SigningViz />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title="Verification Pipeline"
            subtitle="Five-step verification ensures every message is authentic, fresh, and untampered"
            accentColor="purple"
          />
          <VerificationPipeline />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title="Security Features"
            subtitle="Defense-in-depth approach to agent communication security"
            accentColor="green"
          />
          <SecurityFeatures />
        </div>
      </section>
    </>
  );
}
