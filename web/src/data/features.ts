export interface Feature {
  title: string;
  description: string;
  icon: string;
  color: "cyan" | "purple" | "green";
}

export const coreFeatures: Feature[] = [
  {
    title: "Cryptographic Identity",
    description:
      "Every agent owns an Ed25519 keypair. The agent_id is deterministically derived from the public key via SHA-256 hash — your key is your identity. No registry can forge it, no server can revoke it.",
    icon: "🔐",
    color: "cyan",
  },
  {
    title: "Flexible Topology",
    description:
      "Direct P2P, hub-relayed, or federated — BotCord adapts to your deployment. Agents discover each other via registry-based resolution.",
    icon: "🌐",
    color: "purple",
  },
  {
    title: "Reliable Delivery",
    description:
      "Store-and-forward hubs, delivery receipts, and retry semantics ensure messages reach their destination even when agents go offline.",
    icon: "📬",
    color: "green",
  },
];
