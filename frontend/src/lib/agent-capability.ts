/**
 * [INPUT]: GET /api/dashboard/agents/{agentId}/capability response
 * [OUTPUT]: AgentCapability types shared by api client and capability card
 * [POS]: Six general axes (CLEAR + autonomy), each scored per evidence layer (L0 declared, L1 observed)
 * [PROTOCOL]: update header on changes
 */

export type CapabilityLayerKey = "l0" | "l1";

export type CapabilityAxisKey =
  | "efficacy"
  | "latency"
  | "reliability"
  | "cost"
  | "autonomy"
  | "assurance";

export interface CapabilityEvidence {
  score: number | null;
  value: unknown;
  sample: number | null;
  /** Share of a smoothed score that comes from observation (0–1); null when not smoothed. */
  confidence: number | null;
}

export interface CapabilityAxis {
  key: CapabilityAxisKey;
  layers: Record<CapabilityLayerKey, CapabilityEvidence>;
}

export interface AgentCapability {
  agent_id: string;
  window_days: number;
  computed_at: string;
  layers: CapabilityLayerKey[];
  layer_scores: Record<CapabilityLayerKey, number | null>;
  axes: CapabilityAxis[];
}
