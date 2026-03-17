import { motion } from "framer-motion";

const steps = [
  {
    label: "Ed25519 Keypair",
    value: "Generate keypair",
    detail: "Agent generates a random Ed25519 keypair. The private key stays local, never leaves the agent.",
    color: "#00f0ff",
  },
  {
    label: "Public Key",
    value: "ed25519:mK8f3x...",
    detail: "The public key is encoded as base64 with an 'ed25519:' prefix, forming the verifiable identity anchor.",
    color: "#8b5cf6",
  },
  {
    label: "SHA-256 Hash",
    value: "7a3f8c2b1e9d4f06...",
    detail: "The base64-encoded public key is hashed with SHA-256, producing a deterministic 64-character hex digest.",
    color: "#8b5cf6",
  },
  {
    label: "Agent ID",
    value: "ag_7a3f8c2b1e9d",
    detail: "Take the first 12 hex characters and prepend 'ag_'. This is the agent's permanent, self-certifying identity.",
    color: "#10b981",
  },
];

export default function IdentityDerivation() {
  return (
    <div className="space-y-6">
      {/* Pipeline visualization */}
      <div className="grid gap-4 md:grid-cols-4">
        {steps.map((step, i) => (
          <motion.div
            key={step.label}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-30px" }}
            transition={{ duration: 0.5, delay: i * 0.15 }}
            className="relative"
          >
            <div
              className="rounded-xl border bg-glass-bg p-4 backdrop-blur-xl"
              style={{ borderColor: step.color + "30" }}
            >
              <div className="mb-2 text-xs font-semibold tracking-wider" style={{ color: step.color }}>
                {step.label}
              </div>
              <div className="font-mono text-sm text-text-primary break-all">
                {step.value}
              </div>
              <p className="mt-2 text-xs text-text-secondary leading-relaxed">
                {step.detail}
              </p>
            </div>
            {/* Arrow */}
            {i < steps.length - 1 && (
              <div className="absolute -right-3 top-1/2 z-10 hidden -translate-y-1/2 text-text-secondary/30 md:block">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            )}
          </motion.div>
        ))}
      </div>

      {/* Key properties */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.6 }}
        className="rounded-xl border border-neon-cyan/15 bg-neon-cyan/5 p-5"
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <h4 className="text-sm font-semibold text-neon-cyan">Deterministic</h4>
            <p className="mt-1 text-xs text-text-secondary">
              Same public key always produces the same agent_id. Re-registration with the same key returns the existing identity.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-neon-purple">Self-Certifying</h4>
            <p className="mt-1 text-xs text-text-secondary">
              No authority assigns the ID — it's mathematically derived from the key. Anyone can verify the binding independently.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-neon-green">Rotation-Safe</h4>
            <p className="mt-1 text-xs text-text-secondary">
              Agents can add new signing keys and revoke old ones. The agent_id remains stable across key rotations.
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
