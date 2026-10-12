/**
 * [INPUT]: 依赖 framer-motion 进入视口淡入与 VI 字号阶梯（caption 标签 + h1 36/1.15 标题 + body-lg 说明）
 * [OUTPUT]: 对外提供 HomeSectionHeader：首页左对齐区块标题（小标签 + 标题 + 可选说明 + 可选右侧链接）
 * [POS]: marketing 首页各区块共用的标题；其他营销页仍用居中的 SectionHeading
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";

interface HomeSectionHeaderProps {
  label: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export default function HomeSectionHeader({ label, title, subtitle, action }: HomeSectionHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
      className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4"
    >
      <div>
        <p className="text-xs font-medium text-text-secondary">{label}</p>
        <h2 className="mt-3 text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-text md:text-[36px] md:leading-[1.15] md:tracking-[-0.03em]">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-3 max-w-xl text-base leading-[1.6] text-text-secondary">{subtitle}</p>
        ) : null}
      </div>
      {action}
    </motion.div>
  );
}
