"use client";

import type { ReactNode } from "react";

export interface PrimaryNavButtonProps {
  active: boolean;
  activeTone: "cyan" | "purple";
  badge?: ReactNode;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title: string;
}

export function PrimaryNavButton({
  active,
  activeTone,
  badge,
  disabled = false,
  icon,
  label,
  onClick,
  title,
}: PrimaryNavButtonProps) {
  const activeClass = activeTone === "purple"
    ? "bg-neon-purple/15 text-neon-purple"
    : "bg-neon-cyan/15 text-neon-cyan";
  const indicatorClass = activeTone === "purple" ? "bg-neon-purple" : "bg-neon-cyan";

  return (
    <button
      onClick={onClick}
      className={`group relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition-all duration-200 max-md:h-12 max-md:min-w-0 max-md:flex-1 max-md:px-1 ${
        disabled
          ? "text-text-secondary/45 hover:bg-neon-cyan/10 hover:text-neon-cyan"
          : active
          ? activeClass
          : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
      }`}
      title={title}
    >
      {badge}
      {icon}
      <span className="mt-0.5 max-w-full truncate text-[9px] font-medium leading-none">{label}</span>
    </button>
  );
}

export interface SecondaryNavButtonProps {
  active: boolean;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
  onClick: () => void;
  tone: "cyan" | "purple";
}

export function SecondaryNavButton({
  active,
  badge,
  children,
  className = "",
  onClick,
  tone,
}: SecondaryNavButtonProps) {
  const activeClass = tone === "purple"
    ? "border-neon-purple/60 bg-neon-purple/10 text-neon-purple"
    : "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan";

  return (
    <button
      onClick={onClick}
      className={`${className} w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
        active ? activeClass : "border-glass-border text-text-secondary hover:text-text-primary"
      }`}
    >
      {badge ? (
        <span className="flex items-center justify-between gap-3">
          <span>{children}</span>
          {badge}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
