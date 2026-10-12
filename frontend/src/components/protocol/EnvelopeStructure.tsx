"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { envelopeStructure } from "@/lib/i18n/translations/protocol";

const fields = [
  "v",
  "msg_id",
  "ts",
  "from",
  "to",
  "type",
  "payload",
  "payload_hash",
  "sig",
];

export default function EnvelopeStructure() {
  const [activeField, setActiveField] = useState<string | null>(null);
  const locale = useLanguage();
  const t = envelopeStructure[locale];

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {/* JSON structure */}
      <div className="rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface-sunken)] p-6 font-mono text-[13px]">
        <div className="mb-3 text-xs text-[var(--bc-text-secondary)]">
          {t.title}
        </div>
        <div className="space-y-1">
          <span className="text-[var(--bc-text-secondary)]">{"{"}</span>
          {fields.map((field) => (
            <div
              key={field}
              className={`cursor-pointer rounded-md px-2 py-0.5 transition-colors duration-[140ms] ${
                activeField === field
                  ? "bg-[var(--bc-accent-soft)]"
                  : "hover:bg-[var(--bc-surface)]"
              }`}
              onMouseEnter={() => setActiveField(field)}
              onMouseLeave={() => setActiveField(null)}
            >
              <span className="text-[var(--bc-accent-text)]">
                {"  "}"{field}"
              </span>
              <span className="text-[var(--bc-text-secondary)]">: ...</span>
            </div>
          ))}
          <span className="text-[var(--bc-text-secondary)]">{"}"}</span>
        </div>
      </div>

      {/* Description panel */}
      <div className="flex items-center">
        <AnimatePresence mode="wait">
          {activeField ? (
            <motion.div
              key={activeField}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
              className="rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface)] p-6 shadow-[var(--bc-shadow-sm)]"
            >
              <h4 className="font-mono text-lg font-semibold text-[var(--bc-accent-text)]">
                {activeField}
              </h4>
              <p className="mt-2 text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
                {t.fields[activeField]}
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center text-sm text-[var(--bc-text-secondary)]"
            >
              <p>{t.hoverHint}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
