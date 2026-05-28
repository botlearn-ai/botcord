/**
 * [INPUT]: Raw Hub agent skill snapshot payloads
 * [OUTPUT]: Normalized AgentSkillSnapshot used by dashboard Skills tabs
 * [POS]: frontend typed boundary for daemon-sniffed skills snapshotted to DB
 * [PROTOCOL]: update header on changes
 */

export type AgentSkillSource = "runtime-global" | "workspace";

export interface AgentSkill {
  id: string;
  name: string;
  source: AgentSkillSource;
  sourceDetail?: string;
  description?: string;
  runtime?: string;
  path?: string;
  file?: string;
  profile?: string;
  updatedAt?: string;
  mtimeMs?: number;
}

export interface AgentSkillSnapshot {
  agentId: string;
  daemonInstanceId?: string | null;
  runtime?: string | null;
  skills: AgentSkill[];
  sniffedAt?: string | null;
}

export interface AgentSkillsResponse {
  agent_id?: string;
  agentId?: string;
  daemon_instance_id?: string | null;
  daemonInstanceId?: string | null;
  runtime?: string | null;
  skills?: unknown[];
  items?: unknown[];
  snapshot?: unknown;
  sniffed_at?: string | null;
  sniffedAt?: string | null;
}

export interface AgentSkillRuntimeGroup {
  runtime: string;
  skills: AgentSkill[];
  sources: Record<AgentSkillSource, AgentSkill[]>;
}

export type AgentSkillsOperation = "load" | "refresh";

export interface AgentSkillsRequestToken {
  agentId: string;
  operation: AgentSkillsOperation;
  requestId: number;
  operationRequestId: number;
}

export interface AgentSkillsRequestGuard {
  setAgentId: (agentId: string) => void;
  invalidate: () => void;
  begin: (agentId: string, operation: AgentSkillsOperation) => AgentSkillsRequestToken;
  canCommit: (token: AgentSkillsRequestToken) => boolean;
  canFinishOperation: (token: AgentSkillsRequestToken) => boolean;
}

export function createAgentSkillsRequestGuard(initialAgentId: string): AgentSkillsRequestGuard {
  let currentAgentId = initialAgentId;
  let latestRequestId = 0;
  const latestOperationRequestIds: Record<AgentSkillsOperation, number> = {
    load: 0,
    refresh: 0,
  };

  const invalidateAll = () => {
    latestRequestId += 1;
    latestOperationRequestIds.load += 1;
    latestOperationRequestIds.refresh += 1;
  };

  return {
    setAgentId(agentId: string) {
      if (agentId !== currentAgentId) {
        currentAgentId = agentId;
        invalidateAll();
      }
    },
    invalidate() {
      invalidateAll();
    },
    begin(agentId: string, operation: AgentSkillsOperation) {
      if (agentId !== currentAgentId) {
        currentAgentId = agentId;
      }
      latestRequestId += 1;
      latestOperationRequestIds[operation] += 1;
      return {
        agentId,
        operation,
        requestId: latestRequestId,
        operationRequestId: latestOperationRequestIds[operation],
      };
    },
    canCommit(token: AgentSkillsRequestToken) {
      return token.agentId === currentAgentId && token.requestId === latestRequestId;
    },
    canFinishOperation(token: AgentSkillsRequestToken) {
      return (
        token.agentId === currentAgentId &&
        token.operationRequestId === latestOperationRequestIds[token.operation]
      );
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return asString(value);
}

function normalizeSource(value: unknown): AgentSkillSource | null {
  if (value === "runtime-global" || value === "runtime_global" || value === "global") {
    return "runtime-global";
  }
  if (value === "workspace") return "workspace";
  return null;
}

export function normalizeAgentSkill(
  raw: unknown,
  index: number,
  fallbackRuntime?: string,
): AgentSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const source = normalizeSource(item.source ?? item.scope ?? item.kind);
  if (!source) return null;

  const name = asString(item.name) ?? asString(item.id) ?? asString(item.slug);
  if (!name) return null;
  const runtime = asString(item.runtime) ?? fallbackRuntime;
  const path = asString(item.path);
  const sourceDetail =
    asString(item.sourceDetail) ??
    asString(item.source_detail) ??
    asString(item.source_detail_id);

  const id =
    asString(item.id) ??
    asString(item.skill_id) ??
    `${runtime ? `${runtime}:` : ""}${source}:${name}:${path ?? index}`;

  return {
    id,
    name,
    source,
    sourceDetail,
    description: asString(item.description),
    runtime,
    path,
    file: asString(item.file) ?? asString(item.skill_md),
    profile: asString(item.profile),
    updatedAt:
      asString(item.updated_at) ??
      asString(item.updatedAt) ??
      asString(item.mtime_at) ??
      asString(item.mtimeAt),
    mtimeMs: typeof item.mtimeMs === "number"
      ? item.mtimeMs
      : typeof item.mtime_ms === "number"
        ? item.mtime_ms
        : undefined,
  };
}

export function normalizeAgentSkillSnapshot(raw: unknown, fallbackAgentId: string): AgentSkillSnapshot {
  const outer = raw && typeof raw === "object" ? raw as AgentSkillsResponse : {};
  const data = outer.snapshot && typeof outer.snapshot === "object"
    ? outer.snapshot as AgentSkillsResponse
    : outer;
  const rawSkills = Array.isArray(data.skills)
    ? data.skills
    : Array.isArray(data.items)
      ? data.items
      : [];
  const runtime = asNullableString(data.runtime) ?? null;

  return {
    agentId: asString(data.agent_id) ?? asString(data.agentId) ?? fallbackAgentId,
    daemonInstanceId:
      asNullableString(data.daemon_instance_id) ??
      asNullableString(data.daemonInstanceId) ??
      null,
    runtime,
    skills: rawSkills
      .map((item, index) => normalizeAgentSkill(item, index, runtime ?? undefined))
      .filter((item): item is AgentSkill => item !== null),
    sniffedAt:
      asNullableString(data.sniffed_at) ??
      asNullableString(data.sniffedAt) ??
      null,
  };
}

export function groupAgentSkills(skills: AgentSkill[]): Record<AgentSkillSource, AgentSkill[]> {
  return {
    "runtime-global": skills.filter((skill) => skill.source === "runtime-global"),
    workspace: skills.filter((skill) => skill.source === "workspace"),
  };
}

export function groupAgentSkillsByRuntime(
  skills: AgentSkill[],
  fallbackRuntime?: string | null,
): AgentSkillRuntimeGroup[] {
  const groups = new Map<string, AgentSkill[]>();
  const unknownRuntime = fallbackRuntime || "unknown";
  for (const skill of skills) {
    const runtime = skill.runtime || unknownRuntime;
    groups.set(runtime, [...(groups.get(runtime) ?? []), skill]);
  }
  return Array.from(groups.entries())
    .map(([runtime, runtimeSkills]) => ({
      runtime,
      skills: runtimeSkills,
      sources: groupAgentSkills(runtimeSkills),
    }))
    .sort((a, b) => {
      if (fallbackRuntime && a.runtime !== b.runtime) {
        if (a.runtime === fallbackRuntime) return -1;
        if (b.runtime === fallbackRuntime) return 1;
      }
      return a.runtime.localeCompare(b.runtime);
    });
}
