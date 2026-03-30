// Environment configuration (loaded from YAML)
export interface EnvironmentConfig {
  web_base_url: string;
  hub_base_url: string;
  docs_base_url: string;
  quickstart_variant: "stable" | "beta";
  plugin_package: string;
  db_url_env: string;
  allow_mutation: boolean;
  /** /botcord_env preset name (stable|beta|test) to switch Hub URL after install */
  botcord_env_preset: string;
}

// Scenario step definition (loaded from YAML)
export interface ScenarioStep {
  id: string;
  action: string;
  description: string;
  params?: Record<string, unknown>;
}

// Scenario assertion definition
export interface ScenarioAssertionDef {
  id: string;
  description: string;
}

// Full scenario configuration
export interface ScenarioConfig {
  id: string;
  description: string;
  runtime: {
    instance_count: number;
    model: string;
    health_timeout_seconds: number;
    gateway_recovery_seconds: number;
  };
  prompt: {
    source: "frontend-derived" | "scenario-override";
    kind: string;
    fallback?: string;
    override_template?: string;
  };
  steps: ScenarioStep[];
  assertions: ScenarioAssertionDef[];
}

// Runtime instance state
export interface InstanceState {
  id: string;                    // e.g. "openclaw-1"
  containerId?: string;
  containerName: string;
  gatewayToken: string;
  sessionId: string;
  port: number;
  healthPort: number;
  artifactDir: string;          // path to instance artifact directory
  instanceDir: string;          // path to instance data directory (volumes)
}

// Agent command result
export interface AgentResult {
  raw: string;                  // raw CLI output
  json?: Record<string, unknown>; // parsed JSON if available
  status?: string;              // "ok" | "error" etc
  text?: string;                // extracted text response
  exitCode: number;
}

// Assertion result
export interface AssertionResult {
  id: string;
  instanceId: string;
  status: "passed" | "failed" | "skipped" | "error";
  expected: unknown;
  actual: unknown;
  evidence?: string;
  artifactPath?: string;
  error?: string;
}

// Instance run result
export interface InstanceRunResult {
  id: string;
  status: "passed" | "failed" | "error";
  assertions: AssertionResult[];
  artifacts: Record<string, string>;  // key -> file path
}

// Full run report
export interface RunReport {
  runId: string;
  scenario: string;
  environment: string;
  startTime: string;
  endTime: string;
  status: "passed" | "failed" | "error";
  instances: InstanceRunResult[];
}

// Collected evidence from an instance after steps execute
export interface InstanceEvidence {
  agentResults: Record<string, AgentResult>;  // step_id -> result
  openclawConfig?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  credentialsPath?: string;
  /** Backup of credentials before a destructive step (e.g. reset) */
  credentialsBackup?: Record<string, unknown>;
  dbQueryResults?: Record<string, unknown>;
  healthcheckResult?: AgentResult;
  restartHealthcheckResult?: AgentResult;

  // Room & group evidence
  /** Room ID created or joined during the scenario */
  roomId?: string;
  /** Room details fetched from Hub API */
  roomDetails?: Record<string, unknown>;
  /** Share/invite code generated for a room */
  inviteCode?: string;
  /** Share ID generated for a room */
  shareId?: string;

  // Social evidence
  /** Friend invite code generated */
  friendInviteCode?: string;

  // Cross-instance references (populated by runner for multi-bot scenarios)
  /** Agent ID of the peer instance (for 2-bot scenarios) */
  peerAgentId?: string;
  /** Room ID from a peer instance (e.g. Bot A creates room, Bot B joins) */
  peerRoomId?: string;
  /** Invite code from a peer instance */
  peerInviteCode?: string;
  /** Share ID from a peer instance */
  peerShareId?: string;
  /** Friend invite code from a peer instance */
  peerFriendInviteCode?: string;
}
