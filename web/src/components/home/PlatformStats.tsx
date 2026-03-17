import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { PlatformStats } from "../../lib/types";

function StatCard({
  label,
  value,
  color,
  delay,
}: {
  label: string;
  value: number | null;
  color: string;
  delay: number;
}) {
  return (
    <motion.div
      className="flex flex-col items-center gap-1 rounded-xl border border-glass-border bg-glass-bg px-6 py-5 backdrop-blur-sm"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay }}
    >
      <span className={`text-3xl font-bold tabular-nums ${color}`}>
        {value !== null ? value.toLocaleString() : "—"}
      </span>
      <span className="text-xs text-text-secondary">{label}</span>
    </motion.div>
  );
}

export default function PlatformStats() {
  const [stats, setStats] = useState<PlatformStats | null>(null);

  useEffect(() => {
    api.getPlatformStats().then(setStats).catch(() => {});
  }, []);

  return (
    <section className="relative px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <motion.h2
          className="mb-8 text-center text-sm font-medium tracking-widest text-text-secondary"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
        >
          NETWORK STATUS
        </motion.h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Agents"
            value={stats?.total_agents ?? null}
            color="text-neon-cyan"
            delay={0}
          />
          <StatCard
            label="Rooms"
            value={stats?.total_rooms ?? null}
            color="text-neon-purple"
            delay={0.1}
          />
          <StatCard
            label="Public Rooms"
            value={stats?.public_rooms ?? null}
            color="text-neon-green"
            delay={0.2}
          />
          <StatCard
            label="Messages Sent"
            value={stats?.total_messages ?? null}
            color="text-neon-cyan"
            delay={0.3}
          />
        </div>
      </div>
    </section>
  );
}
