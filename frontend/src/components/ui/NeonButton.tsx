/**
 * [INPUT]: 依赖 next/link 处理站内客户端导航，依赖 framer-motion 与 clsx 提供按钮动效与样式变体
 * [OUTPUT]: 对外提供 NeonButton 组件，统一封装营销页 CTA 的链接/按钮形态
 * [POS]: UI 基础按钮原语，被首页、协议页与愿景页复用，负责把视觉风格和导航语义收敛到一个入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { motion } from "framer-motion";
import { clsx } from "clsx";
import type { ReactNode } from "react";
import Link from "next/link";

interface NeonButtonProps {
  children: ReactNode;
  href?: string;
  variant?: "cyan" | "purple" | "green" | "cyan-filled";
  className?: string;
  onClick?: () => void;
}

const variantStyles = {
  cyan: "border-neon-cyan/50 text-neon-cyan shadow-[0_0_15px_rgba(0,240,255,0.2)] hover:shadow-[0_0_25px_rgba(0,240,255,0.4)] hover:bg-neon-cyan/10",
  "cyan-filled":
    "border-neon-cyan bg-neon-cyan text-deep-black font-bold shadow-[0_0_20px_rgba(0,240,255,0.3)] hover:shadow-[0_0_30px_rgba(0,240,255,0.5)] hover:bg-neon-cyan/90",
  purple:
    "border-neon-purple/50 text-neon-purple shadow-[0_0_15px_rgba(139,92,246,0.2)] hover:shadow-[0_0_25px_rgba(139,92,246,0.4)] hover:bg-neon-purple/10",
  green:
    "border-neon-green/50 text-neon-green shadow-[0_0_15px_rgba(16,185,129,0.2)] hover:shadow-[0_0_25px_rgba(16,185,129,0.4)] hover:bg-neon-green/10",
};

export default function NeonButton({
  children,
  href,
  variant = "cyan",
  className,
  onClick,
}: NeonButtonProps) {
  const classes = clsx(
    "inline-flex items-center gap-2 rounded-lg border px-6 py-3 text-sm font-semibold",
    "transition-all duration-300",
    variantStyles[variant],
    className
  );

  const inner = (
    <motion.span
      className="inline-flex items-center gap-2"
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
    >
      {children}
    </motion.span>
  );

  if (href) {
    if (href.startsWith("/")) {
      return (
        <Link href={href} className={classes}>
          {inner}
        </Link>
      );
    }

    return (
      <a href={href} className={classes}>
        {inner}
      </a>
    );
  }

  return (
    <button onClick={onClick} className={classes}>
      {inner}
    </button>
  );
}
