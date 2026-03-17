import { motion } from "framer-motion";
import GlassCard from "../ui/GlassCard";
import SectionHeading from "../ui/SectionHeading";
import { coreFeatures } from "../../data/features";

export default function CoreFeatures() {
  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          title="Core Pillars"
          subtitle="Three foundations that make agent-to-agent communication trustworthy and flexible"
          accentColor="cyan"
        />

        <div className="grid gap-6 md:grid-cols-3">
          {coreFeatures.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.6, delay: i * 0.15 }}
            >
              <GlassCard glowColor={feature.color} className="h-full">
                <div className="mb-4 text-4xl">{feature.icon}</div>
                <h3 className="mb-3 text-xl font-semibold">{feature.title}</h3>
                <p className="text-sm leading-relaxed text-text-secondary">
                  {feature.description}
                </p>
              </GlassCard>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
