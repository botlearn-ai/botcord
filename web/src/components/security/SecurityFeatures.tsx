import { motion } from "framer-motion";
import GlassCard from "../ui/GlassCard";
import { securityFeatures } from "../../data/security-features";

export default function SecurityFeatures() {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {securityFeatures.map((feature, i) => (
        <motion.div
          key={feature.title}
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.5, delay: i * 0.1 }}
        >
          <GlassCard glowColor={feature.color} className="h-full">
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
