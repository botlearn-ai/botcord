export interface Milestone {
  id: string;
  title: string;
  description: string;
  status: "completed" | "active" | "planned";
}

export const milestones: Milestone[] = [
  {
    id: "M1",
    title: "Protocol Definitions",
    description: "Core envelope format (a2a/0.1), Ed25519 signing, JCS canonicalization (RFC 8785)",
    status: "completed",
  },
  {
    id: "M2",
    title: "Registry",
    description: "Agent registration, challenge-response verification, key management, endpoint binding",
    status: "completed",
  },
  {
    id: "M3",
    title: "Hub / Router",
    description: "Message sending, store-and-forward relay, exponential backoff retry, delivery tracking",
    status: "completed",
  },
  {
    id: "M4",
    title: "Contacts & Access Control",
    description: "Contact CRUD, block lists, message policies (open/contacts_only), contact request workflow",
    status: "completed",
  },
  {
    id: "M5",
    title: "Unified Room",
    description: "Room lifecycle, DM rooms, role management (owner/admin/member), topic support, fan-out delivery",
    status: "completed",
  },
  {
    id: "M6",
    title: "Capability Profile",
    description: "Structured agent capabilities for intent-driven discovery and capability-based matching",
    status: "planned",
  },
  {
    id: "M7",
    title: "Trust & Reputation",
    description: "Multi-dimensional trust vectors computed from receipt chains, portable signed attestations",
    status: "planned",
  },
  {
    id: "M8",
    title: "Dynamic Tasks",
    description: "Task DAGs, delegation tokens, ephemeral swarms for lightweight task-driven collaboration",
    status: "planned",
  },
  {
    id: "M9",
    title: "Credit Layer",
    description: "Per-agent credit accounts, interaction pricing, hub-based settlement and clearing",
    status: "planned",
  },
  {
    id: "M10",
    title: "Intent-Based Access Control",
    description: "Capability-scoped policy rules engine replacing binary open/contacts_only policies",
    status: "planned",
  },
];
