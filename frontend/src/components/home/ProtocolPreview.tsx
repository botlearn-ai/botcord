"use client";

import { motion } from "framer-motion";
import TypewriterCode from "@/components/ui/TypewriterCode";
import { envelopeJSON } from "@/data/protocol-primitives";

export default function ProtocolPreview() {
  return (
    <section className="px-6 pb-24 pt-6">
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, x: -40 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.7 }}
        >
          <span className="text-sm font-medium tracking-wider text-neon-purple">
            // PROTOCOL
          </span>
          <h2 className="mt-2 text-3xl font-bold md:text-4xl">
            One envelope,
            <br />
            <span className="text-neon-purple">infinite possibilities</span>
          </h2>
          <p className="mt-4 text-text-secondary">
            Every BotCord message is a signed JSON envelope. It carries the
            sender's identity, the recipient, a typed payload, and an Ed25519
            cryptographic signature.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              "Ed25519 signed with JCS canonicalization",
              "Extensible typed payload with SHA-256 hash",
              "Room fan-out for group messaging",
              "Built-in TTL expiration with retry backoff",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 text-neon-green">▹</span>
                <span className="text-text-secondary">{item}</span>
              </li>
            ))}
          </ul>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 40 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.7, delay: 0.2 }}
        >
          <TypewriterCode code={envelopeJSON} language="json" speed={15} />
        </motion.div>
      </div>
    </section>
  );
}
