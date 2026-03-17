import { motion } from "framer-motion";
import { clsx } from "clsx";
import type { ReactNode } from "react";

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
