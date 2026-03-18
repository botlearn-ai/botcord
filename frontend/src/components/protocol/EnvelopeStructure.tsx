"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { envelopeStructure } from "@/lib/i18n/translations/protocol";

interface Field {
  key: string;
  label: string;
  color: string;
}

const fields: Field[] = [
  { key: "v", label: "v", color: "text-neon-cyan" },
  { key: "msg_id", label: "msg_id", color: "text-neon-cyan" },
  { key: "ts", label: "ts", color: "text-neon-cyan" },
  { key: "from", label: "from", color: "text-neon-green" },
  { key: "to", label: "to", color: "text-neon-green" },
  { key: "type", label: "type", color: "text-neon-purple" },
  { key: "payload", label: "payload", color: "text-neon-purple" },
  { key: "payload_hash", label: "payload_hash", color: "text-neon-purple" },
  { key: "sig", label: "sig", color: "text-neon-cyan" },
];

export default function EnvelopeStructure() {
  const [activeField, setActiveField] = useState<string | null>(null);
  const locale = useLanguage();
  const t = envelopeStructure[locale];

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {/* JSON structure */}
      <div className="rounded-xl border border-glass-border bg-deep-black-light p-6 font-mono text-sm">
        <div className="mb-3 text-xs text-text-secondary">
          {t.title}
        </div>
        <div className="space-y-1">
          <span className="text-text-secondary">{"{"}</span>
          {fields.map((field) => (
            <div
              key={field.key}
              className={`cursor-pointer rounded px-2 py-0.5 transition-all duration-200 ${
                activeField === field.key
                  ? "bg-neon-cyan/10 shadow-[0_0_10px_rgba(0,240,255,0.1)]"
                  : "hover:bg-glass-bg"
              }`}
              onMouseEnter={() => setActiveField(field.key)}
              onMouseLeave={() => setActiveField(null)}
            >
              <span className={field.color}>
                {"  "}"{field.key}"
              </span>
              <span className="text-text-secondary">: ...</span>
            </div>
          ))}
          <span className="text-text-secondary">{"}"}</span>
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
              className="rounded-xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl"
            >
              <h4
                className={`font-mono text-lg font-bold ${fields.find((f) => f.key === activeField)?.color}`}
              >
                {activeField}
              </h4>
              <p className="mt-2 text-sm text-text-secondary">
                {t.fields[activeField]}
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center text-sm text-text-secondary"
            >
              <p>{t.hoverHint}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
