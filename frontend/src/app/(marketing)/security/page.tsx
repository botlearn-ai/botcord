"use client";

import SectionHeading from "@/components/ui/SectionHeading";
import IdentityDerivation from "@/components/security/IdentityDerivation";
import SigningViz from "@/components/security/SigningViz";
import VerificationPipeline from "@/components/security/VerificationPipeline";
import SecurityFeatures from "@/components/security/SecurityFeatures";
import MouseFollowLight from "@/components/ui/MouseFollowLight";
import { useLanguage } from "@/lib/i18n";
import { securityPage } from "@/lib/i18n/translations/security";

export default function SecurityPage() {
  const locale = useLanguage();
  const t = securityPage[locale];

  return (
    <>
      <MouseFollowLight />

      <section className="px-6 pb-24 pt-32">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title={t.sections[0].title}
            subtitle={t.sections[0].subtitle}
            accentColor="cyan"
          />
          <IdentityDerivation />
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title={t.sections[1].title}
            subtitle={t.sections[1].subtitle}
            accentColor="cyan"
          />
          <SigningViz />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title={t.sections[2].title}
            subtitle={t.sections[2].subtitle}
            accentColor="purple"
          />
          <VerificationPipeline />
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title={t.sections[3].title}
            subtitle={t.sections[3].subtitle}
            accentColor="green"
          />
          <SecurityFeatures />
        </div>
      </section>
    </>
  );
}
