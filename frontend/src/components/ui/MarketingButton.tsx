/**
 * [INPUT]: 依赖 next/link 处理站内客户端导航，依赖 clsx 与 VI token（--bc-accent / --bc-surface / --bc-border）提供按钮样式
 * [OUTPUT]: 对外提供 MarketingButton 组件，统一封装营销页 CTA 的链接/按钮形态（primary 主色填充 / secondary 中性描边）
 * [POS]: UI 基础按钮原语，被首页、协议页、愿景页与下载页复用，负责把视觉风格和导航语义收敛到一个入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { clsx } from "clsx";
import type { ReactNode } from "react";
import Link from "next/link";

interface MarketingButtonProps {
  children: ReactNode;
  href?: string;
  variant?: "primary" | "secondary";
  className?: string;
  onClick?: () => void;
}

const variantStyles = {
  primary:
    "border-transparent bg-[var(--bc-accent)] text-[var(--bc-on-accent)] shadow-[var(--bc-shadow-sm)] hover:bg-[var(--bc-accent-hover)]",
  secondary:
    "border-[var(--bc-border-strong)] bg-[var(--bc-surface)] text-[var(--bc-text)] hover:bg-[var(--bc-surface-sunken)]",
};

export default function MarketingButton({
  children,
  href,
  variant = "secondary",
  className,
  onClick,
}: MarketingButtonProps) {
  const classes = clsx(
    "inline-flex h-11 items-center gap-2 rounded-lg border px-5 text-sm font-medium",
    "transition-colors duration-[140ms] ease-[cubic-bezier(0.2,0,0,1)]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bc-focus-ring)]",
    variantStyles[variant],
    className
  );

  if (href) {
    if (href.startsWith("/")) {
      return (
        <Link href={href} className={classes}>
          {children}
        </Link>
      );
    }

    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }

  return (
    <button onClick={onClick} className={classes}>
      {children}
    </button>
  );
}
