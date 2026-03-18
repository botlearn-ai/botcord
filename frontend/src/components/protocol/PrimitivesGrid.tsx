"use client";

import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import { primitives } from "@/data/protocol-primitives";

const icons: Record<string, React.ReactNode> = {
  Contact: (
    <svg
      className="h-10 w-10"
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="14" cy="16" r="5" className="text-neon-cyan" />
      <circle cx="26" cy="16" r="5" className="text-neon-cyan" />
      <path d="M19 16h2" className="text-neon-cyan" strokeDasharray="2 2">
        <animate
          attributeName="stroke-dashoffset"
          values="0;4"
          dur="1s"
          repeatCount="indefinite"
        />
      </path>
      <path
        d="M4 34c0-6 4-10 10-10M26 24c6 0 10 4 10 10"
        className="text-neon-cyan/50"
      />
    </svg>
  ),
  Group: (
    <svg
      className="h-10 w-10"
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="20" cy="12" r="4" className="text-neon-purple" />
      <circle cx="10" cy="20" r="4" className="text-neon-purple" />
      <circle cx="30" cy="20" r="4" className="text-neon-purple" />
      <circle cx="15" cy="30" r="4" className="text-neon-purple" />
      <circle cx="25" cy="30" r="4" className="text-neon-purple" />
      <path
        d="M20 16v10M14 22l6 6M26 22l-6 6M13 22l4 6M27 22l-4 6"
        className="text-neon-purple/30"
        strokeDasharray="2 2"
      >
        <animate
          attributeName="stroke-dashoffset"
          values="0;4"
          dur="2s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  ),
  Channel: (
    <svg
      className="h-10 w-10"
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="8" cy="20" r="4" className="text-neon-green" />
      <path d="M12 20h6" className="text-neon-green" />
      <path d="M18 20l4-8M18 20l4 8M18 20h8" className="text-neon-green/60">
        <animate
          attributeName="stroke-dashoffset"
          values="0;8"
          dur="1.5s"
          repeatCount="indefinite"
        />
      </path>
      <circle cx="34" cy="12" r="3" className="text-neon-green/50" />
      <circle cx="34" cy="20" r="3" className="text-neon-green/50" />
      <circle cx="34" cy="28" r="3" className="text-neon-green/50" />
    </svg>
  ),
};

export default function PrimitivesGrid() {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {primitives.map((prim, i) => (
        <motion.div
          key={prim.name}
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.6, delay: i * 0.15 }}
        >
          <GlassCard glowColor={prim.color} className="h-full">
            <div className="mb-4">{icons[prim.name]}</div>
            <h3 className="mb-2 text-xl font-semibold">{prim.name}</h3>
            <p className="mb-4 text-sm text-text-secondary">
              {prim.description}
            </p>
            <ul className="space-y-2">
              {prim.details.map((d) => (
                <li key={d} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5 text-neon-cyan">▹</span>
                  <span className="text-text-secondary">{d}</span>
                </li>
              ))}
            </ul>
          </GlassCard>
        </motion.div>
      ))}
    </div>
  );
}
