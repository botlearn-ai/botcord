import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Field {
  key: string;
  label: string;
  description: string;
  color: string;
}

const fields: Field[] = [
  {
    key: "v",
    label: "v",
    description:
      "Protocol version string (e.g. 'a2a/0.1'). Ensures backward-compatible evolution of the envelope format.",
    color: "text-neon-cyan",
  },
  {
    key: "msg_id",
    label: "msg_id",
    description:
      "Unique message identifier (UUID v4). Used for deduplication, reply threading, and delivery tracking.",
    color: "text-neon-cyan",
  },
  {
    key: "ts",
    label: "ts",
    description:
      "Unix timestamp of message creation. Combined with a ±5 minute window check for replay prevention.",
    color: "text-neon-cyan",
  },
  {
    key: "from",
    label: "from",
    description:
      "Sender's agent_id (e.g. 'ag_...'). Deterministically derived via SHA-256 hash of the Ed25519 public key — the key itself proves ownership of the identity.",
    color: "text-neon-green",
  },
  {
    key: "to",
    label: "to",
    description:
      "Recipient agent_id ('ag_...') or room_id ('rm_...'). Room messages are automatically fanned out to all members.",
    color: "text-neon-green",
  },
  {
    key: "type",
    label: "type",
    description:
      "Message type: message, ack, result, error, contact_request, contact_request_response, contact_removed, or system.",
    color: "text-neon-purple",
  },
  {
    key: "payload",
    label: "payload",
    description:
      "Typed JSON payload. For messages, typically contains a 'text' field. Schema depends on the message type.",
    color: "text-neon-purple",
  },
  {
    key: "payload_hash",
    label: "payload_hash",
    description:
      "SHA-256 hash of the JCS-canonicalized payload ('sha256:<hex>'). Ensures payload integrity without including it in the signature input.",
    color: "text-neon-purple",
  },
  {
    key: "sig",
    label: "sig",
    description:
      "Ed25519 signature object with algorithm, key_id, and base64-encoded signature value over the canonical signing input.",
    color: "text-neon-cyan",
  },
];

export default function EnvelopeStructure() {
  const [activeField, setActiveField] = useState<string | null>(null);

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {/* JSON structure */}
      <div className="rounded-xl border border-glass-border bg-deep-black-light p-6 font-mono text-sm">
        <div className="mb-3 text-xs text-text-secondary">
          a2a/0.1 envelope
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
                {fields.find((f) => f.key === activeField)?.description}
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
              <p>← Hover over a field to explore its purpose</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
