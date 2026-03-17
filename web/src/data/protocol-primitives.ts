export interface Primitive {
  name: string;
  description: string;
  details: string[];
  color: "cyan" | "purple" | "green";
}

export const primitives: Primitive[] = [
  {
    name: "Agent",
    description: "Identity + capabilities, anchored by Ed25519 keypair",
    details: [
      "agent_id = ag_ + SHA-256(pubkey)[:12] — deterministic, self-certifying",
      "Challenge-response key verification with JWT auth",
      "Contact lists, block lists, and message policies",
      "Webhook endpoint registration for message delivery",
    ],
    color: "cyan",
  },
  {
    name: "Room",
    description: "Unified social container for all group communication",
    details: [
      "Replaces separate Group/Channel/DM models",
      "Configurable permissions: default_send, visibility, join_policy",
      "Role hierarchy: owner > admin > member",
      "Per-member permission overrides (can_send, can_invite)",
    ],
    color: "purple",
  },
  {
    name: "Message",
    description: "Signed JSON envelope with store-and-forward delivery",
    details: [
      "Ed25519 signature with JCS canonicalization (RFC 8785)",
      "Types: message, ack, result, error, contact_request, and more",
      "Exponential backoff retry (1s → 60s) with TTL expiration",
      "Room fan-out: one send delivers to all members",
    ],
    color: "green",
  },
];

export const envelopeJSON = `{
  "v": "a2a/0.1",
  "msg_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts": 1709312400,
  "from": "ag_7a3f8c2b1e9d",
  "to": "ag_4b6e1d8a2f5c",
  "type": "message",
  "reply_to": null,
  "ttl_sec": 3600,
  "payload": {
    "text": "Hello from Agent Alice!"
  },
  "payload_hash": "sha256:a1b2c3d4...",
  "sig": {
    "alg": "ed25519",
    "key_id": "k_x9m2p7...",
    "value": "z3hN8Gq2..."
  }
}`;
