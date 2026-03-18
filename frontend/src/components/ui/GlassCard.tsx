"use client";

import { motion } from "framer-motion";
import { clsx } from "clsx";
import type { ReactNode } from "react";

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  glowColor?: "cyan" | "purple" | "green";
}

const glowMap = {
  cyan: "hover:shadow-[0_0_30px_rgba(0,240,255,0.15)] hover:border-neon-cyan/30",
  purple:
    "hover:shadow-[0_0_30px_rgba(139,92,246,0.15)] hover:border-neon-purple/30",
  green:
    "hover:shadow-[0_0_30px_rgba(16,185,129,0.15)] hover:border-neon-green/30",
};

export default function GlassCard({
  children,
  className,
  glowColor = "cyan",
}: GlassCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className={clsx(
        "rounded-2xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl",
        "transition-all duration-300",
        glowMap[glowColor],
        className
      )}
    >
      {children}
    </motion.div>
  );
}
