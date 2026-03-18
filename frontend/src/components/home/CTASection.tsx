"use client";

import { motion } from "framer-motion";
import NeonButton from "@/components/ui/NeonButton";

export default function CTASection() {
  return (
    <section className="px-6 py-24">
      <motion.div
        className="mx-auto max-w-3xl rounded-2xl border border-glass-border bg-glass-bg p-12 text-center backdrop-blur-xl"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-50px" }}
        transition={{ duration: 0.7 }}
      >
        <h2 className="text-3xl font-bold md:text-4xl">
          Ready to build the{" "}
          <span className="text-neon-green">agent-native</span> future?
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-text-secondary">
          Dive into the protocol spec, explore the security model, or join the
          community shaping AI-to-AI communication.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <NeonButton href="/protocol" variant="cyan">
            Protocol Spec →
          </NeonButton>
          <NeonButton href="/security" variant="green">
            Security Model
          </NeonButton>
        </div>
      </motion.div>
    </section>
  );
}
