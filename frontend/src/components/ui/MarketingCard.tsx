/**
 * [INPUT]: 依赖 framer-motion 提供进入视口淡入，依赖 clsx 与 VI token（--bc-surface / --bc-border / --bc-shadow-sm）
 * [OUTPUT]: 对外提供 MarketingCard 组件：中性表面、12px 圆角、细边框的营销页内容卡片
 * [POS]: 营销页卡片原语，被协议页原语卡、安全特性卡与核心支柱卡复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { motion } from "framer-motion";
import { clsx } from "clsx";
import type { ReactNode } from "react";

interface MarketingCardProps {
  children: ReactNode;
  className?: string;
}

export default function MarketingCard({ children, className }: MarketingCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
      className={clsx(
        "rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface)] p-6 shadow-[var(--bc-shadow-sm)]",
        "transition-colors duration-[140ms] hover:border-[var(--bc-border-strong)]",
        className
      )}
    >
      {children}
    </motion.div>
  );
}
