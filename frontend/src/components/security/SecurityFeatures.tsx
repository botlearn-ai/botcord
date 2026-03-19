"use client";

import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import { securityFeatures } from "@/data/security-features";
import { useLanguage } from "@/lib/i18n";
import { securityFeatures as securityFeaturesT } from "@/lib/i18n/translations/security";

export default function SecurityFeatures() {
  const locale = useLanguage();
  const translatedFeatures = securityFeaturesT[locale];

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {translatedFeatures.map((feature, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.5, delay: i * 0.1 }}
        >
          <GlassCard glowColor={securityFeatures[i].color} className="h-full">
            <h3 className="mb-2 text-lg font-semibold">{feature.title}</h3>
            <p className="text-sm leading-relaxed text-text-secondary">
              {feature.description}
            </p>
          </GlassCard>
        </motion.div>
      ))}
    </div>
  );
}
