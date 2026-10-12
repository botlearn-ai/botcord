/**
 * [INPUT]: 依赖 framer-motion 提供进入视口淡入，依赖 clsx 与 VI 字号阶梯（h2 28/1.2/600）
 * [OUTPUT]: 对外提供 SectionHeading 组件：营销页区块标题 + 副标题
 * [POS]: 营销页区块标题原语，被首页、协议页、安全页与愿景页复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { motion } from "framer-motion";
import { clsx } from "clsx";

interface SectionHeadingProps {
  title: string;
  subtitle?: string;
  className?: string;
}

export default function SectionHeading({
  title,
  subtitle,
  className,
}: SectionHeadingProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
      className={clsx("mb-12 text-center", className)}
    >
      <h2 className="text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-[var(--bc-text)]">
        {title}
      </h2>
      {subtitle && (
        <p className="mx-auto mt-3 max-w-2xl text-base leading-[1.6] text-[var(--bc-text-secondary)]">
          {subtitle}
        </p>
      )}
    </motion.div>
  );
}
