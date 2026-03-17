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
      className="overflow-hidden rounded-xl border border-glass-border bg-deep-black-light"
    >
      <div className="flex items-center gap-2 border-b border-glass-border px-4 py-2">
        <div className="h-3 w-3 rounded-full bg-red-500/60" />
        <div className="h-3 w-3 rounded-full bg-yellow-500/60" />
        <div className="h-3 w-3 rounded-full bg-green-500/60" />
        <span className="ml-2 text-xs text-text-secondary">{language}</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-sm leading-relaxed text-neon-green/90">
        <code>{displayedText}</code>
        {displayedText.length < code.length && (
          <span className="animate-pulse text-neon-cyan">▌</span>
        )}
      </pre>
    </motion.div>
  );
}
