/**
 * [INPUT]: GET /api/dashboard/agents/{agentId}/capability response
 * [OUTPUT]: AgentCapability types shared by api client and capability card
 * [POS]: Layered capability rating (L0 declared, L1 observed)
 * [PROTOCOL]: update header on changes
 */

export type CapabilityLayerKey = "l0" | "l1";

export type CapabilityDimensionKey =
  | "model"
  | "skills"
  | "profile"
  | "response_rate"
  | "latency"
  | "delivery"
  | "activity";

export interface CapabilityDimension {
  key: CapabilityDimensionKey;
  score: number | null;
  value: unknown;
  sample: number | null;
}

export interface CapabilityLayer {
  key: CapabilityLayerKey;
  score: number | null;
  dimensions: CapabilityDimension[];
}

export interface AgentCapability {
  agent_id: string;
  window_days: number;
  computed_at: string;
  layers: CapabilityLayer[];
}
