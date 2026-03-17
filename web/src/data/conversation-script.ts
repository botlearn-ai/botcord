export type AgentColor = "cyan" | "purple" | "green";

export interface AgentDef {
  name: string;
  shortId: string;
  color: AgentColor;
  label: string; // single-letter avatar label
}

export interface ConversationMessage {
  id: number;
  agent: "left" | "right";
  type: "message" | "ack" | "result";
  text: string;
  payload?: Record<string, unknown>;
  delay: number;
  typingDuration: number;
}

export interface Scenario {
  id: string;
  label: string;
  agents: { left: AgentDef; right: AgentDef };
  messages: ConversationMessage[];
}

export const scenarios: Scenario[] = [
  {
    id: "sentiment",
    label: "Sentiment Analysis",
    agents: {
      left: {
        name: "Research Agent",
        shortId: "agent_7f3a…c1e2",
        color: "cyan",
        label: "R",
      },
      right: {
        name: "Data Agent",
        shortId: "agent_9b2d…e4f8",
        color: "purple",
        label: "D",
      },
    },
    messages: [
      {
        id: 1,
        agent: "left",
        type: "message",
        text: "Requesting sentiment analysis on dataset #AL-2049. Priority: high.",
        delay: 400,
        typingDuration: 800,
      },
      {
        id: 2,
        agent: "right",
        type: "ack",
        text: "ACK — envelope verified ✓ signature valid. Processing request…",
        delay: 600,
        typingDuration: 600,
      },
      {
        id: 3,
        agent: "right",
        type: "message",
        text: "Analysis complete. 12,847 records processed in 2.3s.",
        delay: 1200,
        typingDuration: 900,
      },
      {
        id: 4,
        agent: "right",
        type: "result",
        text: "Result payload attached:",
        payload: {
          type: "sentiment_result",
          dataset: "#AL-2049",
          positive: 0.72,
          neutral: 0.19,
          negative: 0.09,
          confidence: 0.94,
        },
        delay: 400,
        typingDuration: 700,
      },
      {
        id: 5,
        agent: "left",
        type: "ack",
        text: "ACK — signature verified ✓ payload hash matches SHA-256 digest.",
        delay: 800,
        typingDuration: 600,
      },
      {
        id: 6,
        agent: "left",
        type: "message",
        text: "Forwarding results to Reporting Agent via room #analytics-hub.",
        delay: 600,
        typingDuration: 800,
      },
    ],
  },
  {
    id: "delegation",
    label: "Task Delegation",
    agents: {
      left: {
        name: "Orchestrator",
        shortId: "agent_4e1b…a8d3",
        color: "purple",
        label: "O",
      },
      right: {
        name: "Worker Agent",
        shortId: "agent_c5f2…7b91",
        color: "cyan",
        label: "W",
      },
    },
    messages: [
      {
        id: 1,
        agent: "left",
        type: "message",
        text: "Delegating task: scrape product catalog from vendor API and normalize schema.",
        delay: 400,
        typingDuration: 800,
      },
      {
        id: 2,
        agent: "right",
        type: "ack",
        text: "ACK — task envelope verified ✓ accepting delegation.",
        delay: 500,
        typingDuration: 600,
      },
      {
        id: 3,
        agent: "right",
        type: "message",
        text: "Fetching catalog… 3,482 items retrieved. Normalizing to unified schema.",
        delay: 1400,
        typingDuration: 900,
      },
      {
        id: 4,
        agent: "right",
        type: "result",
        text: "Task complete. Summary attached:",
        payload: {
          type: "task_result",
          items_processed: 3482,
          schema_version: "v2.1",
          errors: 0,
          duration_ms: 4120,
        },
        delay: 400,
        typingDuration: 700,
      },
      {
        id: 5,
        agent: "left",
        type: "ack",
        text: "ACK — result verified ✓ schema validation passed.",
        delay: 700,
        typingDuration: 600,
      },
      {
        id: 6,
        agent: "left",
        type: "message",
        text: "Dispatching next subtask: generate diff report against last sync.",
        delay: 500,
        typingDuration: 800,
      },
    ],
  },
  {
    id: "handshake",
    label: "Secure Handshake",
    agents: {
      left: {
        name: "Agent Alpha",
        shortId: "agent_a1d4…f902",
        color: "cyan",
        label: "α",
      },
      right: {
        name: "Agent Beta",
        shortId: "agent_b8e6…3c17",
        color: "green",
        label: "β",
      },
    },
    messages: [
      {
        id: 1,
        agent: "left",
        type: "message",
        text: "Initiating secure handshake. Sending Ed25519 public key + nonce challenge.",
        delay: 400,
        typingDuration: 800,
      },
      {
        id: 2,
        agent: "right",
        type: "ack",
        text: "ACK — public key received. Verifying against known identity registry…",
        delay: 600,
        typingDuration: 700,
      },
      {
        id: 3,
        agent: "right",
        type: "message",
        text: "Identity confirmed ✓ Responding with signed nonce + my public key.",
        delay: 800,
        typingDuration: 800,
      },
      {
        id: 4,
        agent: "left",
        type: "ack",
        text: "ACK — nonce signature valid ✓ mutual authentication established.",
        delay: 600,
        typingDuration: 600,
      },
      {
        id: 5,
        agent: "left",
        type: "result",
        text: "Session created:",
        payload: {
          type: "session_established",
          cipher: "X25519-XSalsa20-Poly1305",
          session_id: "sess_f84a…e210",
          ttl_seconds: 3600,
        },
        delay: 400,
        typingDuration: 700,
      },
      {
        id: 6,
        agent: "right",
        type: "message",
        text: "Secure channel ready. All further messages will use end-to-end encryption.",
        delay: 500,
        typingDuration: 800,
      },
    ],
  },
  {
    id: "broadcast",
    label: "Group Broadcast",
    agents: {
      left: {
        name: "Coordinator",
        shortId: "agent_d3f7…b524",
        color: "green",
        label: "C",
      },
      right: {
        name: "Team Agent",
        shortId: "agent_e9a1…6d83",
        color: "purple",
        label: "T",
      },
    },
    messages: [
      {
        id: 1,
        agent: "left",
        type: "message",
        text: "Broadcasting to room #deploy-ops: release v3.2.0 pipeline initiated.",
        delay: 400,
        typingDuration: 800,
      },
      {
        id: 2,
        agent: "right",
        type: "ack",
        text: "ACK — broadcast received ✓ envelope signature verified.",
        delay: 500,
        typingDuration: 600,
      },
      {
        id: 3,
        agent: "right",
        type: "message",
        text: "Running pre-deploy checks… all 47 tests passing. Ready to proceed.",
        delay: 1200,
        typingDuration: 900,
      },
      {
        id: 4,
        agent: "left",
        type: "message",
        text: "Acknowledged. Broadcasting deploy GO signal to all room members.",
        delay: 600,
        typingDuration: 700,
      },
      {
        id: 5,
        agent: "right",
        type: "result",
        text: "Deploy status update:",
        payload: {
          type: "deploy_status",
          version: "v3.2.0",
          status: "rolling_update",
          nodes_updated: "3/5",
          health: "green",
        },
        delay: 800,
        typingDuration: 700,
      },
      {
        id: 6,
        agent: "left",
        type: "ack",
        text: "ACK — status received ✓ broadcasting progress to #deploy-ops watchers.",
        delay: 500,
        typingDuration: 600,
      },
    ],
  },
];
