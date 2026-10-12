"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

interface TypewriterCodeProps {
  code: string;
  language?: string;
  speed?: number;
}

export default function TypewriterCode({
  code,
  language = "json",
  speed = 20,
}: TypewriterCodeProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;

    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayedText(code.slice(0, i));
      if (i >= code.length) clearInterval(interval);
    }, speed);

    return () => clearInterval(interval);
  }, [started, code, speed]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5 }}
      className="overflow-hidden rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface-sunken)] shadow-[var(--bc-shadow-sm)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--bc-border)] bg-[var(--bc-surface)] px-4 py-2">
        <div className="h-2.5 w-2.5 rounded-full bg-[var(--bc-border-strong)]" />
        <div className="h-2.5 w-2.5 rounded-full bg-[var(--bc-border-strong)]" />
        <div className="h-2.5 w-2.5 rounded-full bg-[var(--bc-border-strong)]" />
        <span className="ml-2 font-mono text-xs text-[var(--bc-text-secondary)]">{language}</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-[1.5] text-[var(--bc-text)]">
        <code>{displayedText}</code>
        {displayedText.length < code.length && (
          <span className="text-[var(--bc-brand)]">▌</span>
        )}
      </pre>
    </motion.div>
  );
}
