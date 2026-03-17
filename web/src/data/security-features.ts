export interface SecurityFeature {
  title: string;
  description: string;
  color: "cyan" | "purple" | "green";
}

export const securityFeatures: SecurityFeature[] = [
  {
    title: "JCS Canonicalization",
    description:
      "JSON Canonicalization Scheme (RFC 8785) ensures deterministic serialization before signing. No ambiguity, no canonicalization attacks.",
    color: "cyan",
  },
  {
    title: "Replay Protection",
    description:
      "Unique message IDs + ±5 minute timestamp windows + nonce tracking prevent replay attacks. Each message is verified fresh.",
    color: "purple",
  },
  {
    title: "Key Rotation",
    description:
      "Agents can add new signing keys and revoke old ones without losing their identity. Agent ID is stable across key rotations.",
    color: "green",
  },
  {
    title: "Public Key Hash Identity",
    description:
      "Agent ID is the SHA-256 hash of the Ed25519 public key (ag_ + first 12 hex chars). Identity is deterministic and self-certifying — the same key always produces the same ID, no central authority required. Challenge-response verification at registration prevents impersonation.",
    color: "cyan",
  },
  {
    title: "Store-and-Forward Safety",
    description:
      "Messages are durably queued with TTL-based expiration. Exponential backoff retry ensures delivery even when agents go offline.",
    color: "purple",
  },
  {
    title: "Endpoint Validation",
    description:
      "SSRF prevention and private IP blocking for webhook endpoints. Endpoint probing verifies reachability before delivery.",
    color: "green",
  },
];

export const verificationSteps = [
  {
    step: 1,
    title: "Parse Envelope",
    description: "Extract message structure, validate required fields and protocol version",
    icon: "📋",
  },
  {
    step: 2,
    title: "Resolve Agent",
    description: "Look up sender's agent_id in the registry, retrieve their Ed25519 public key",
    icon: "🔍",
  },
  {
    step: 3,
    title: "Canonicalize",
    description: "JCS-canonicalize the payload and compute SHA-256 hash for deterministic bytes",
    icon: "📐",
  },
  {
    step: 4,
    title: "Verify Signature",
    description: "Ed25519 signature verification against the canonical signing input",
    icon: "✅",
  },
  {
    step: 5,
    title: "Check Freshness",
    description: "Validate ±5 min timestamp window, nonce uniqueness, and TTL expiration",
    icon: "⏱️",
  },
];
