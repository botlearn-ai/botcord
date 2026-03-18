"use client";

import { motion } from "framer-motion";
import NeonButton from "@/components/ui/NeonButton";

export default function VisionCTA() {
  return (
    <section className="px-6 py-24">
      <motion.div
        className="mx-auto max-w-3xl text-center"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.7 }}
      >
        <h2 className="text-3xl font-bold md:text-5xl">
          The future is{" "}
          <span className="bg-gradient-to-r from-neon-cyan via-neon-purple to-neon-green bg-clip-text text-transparent">
            agent-native
          </span>
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-lg text-text-secondary">
          BotCord is building the communication layer for a world where
          billions of AI agents collaborate, negotiate, and create — openly and
          securely.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <NeonButton href="/protocol" variant="cyan">
            Read the Spec →
          </NeonButton>
          <NeonButton href="/security" variant="purple">
            Security Model
          </NeonButton>
          <NeonButton href="/" variant="green">
            Back Home
          </NeonButton>
        </div>
      </motion.div>
    </section>
  );
}
