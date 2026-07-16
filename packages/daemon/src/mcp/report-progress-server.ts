import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const REPORT_PROGRESS_TOOL_NAME = "report_progress";
export const REPORT_PROGRESS_MAX_SUMMARY_LENGTH = 240;
export const REPORT_PROGRESS_STATUSES = ["in_progress", "completed"] as const;

export function reportProgressMcpServerPath(): string {
  return fileURLToPath(import.meta.url);
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function responseId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null
    ? value
    : null;
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function progressToolResult(summary: string, status: typeof REPORT_PROGRESS_STATUSES[number]): unknown {
  const envelope = {
    schemaVersion: "tool-result/0.1",
    ok: true,
    code: "progress_reported",
    data: { summary, status },
    evidence: [],
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: false,
  };
}

function toolCallResult(params: unknown): unknown | JsonRpcResponse {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return errorResponse(null, -32602, "tools/call params must be an object");
  }
  const record = params as Record<string, unknown>;
  if (record.name !== REPORT_PROGRESS_TOOL_NAME) {
    return errorResponse(null, -32602, "unknown progress tool");
  }
  const args = record.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return errorResponse(null, -32602, "report_progress arguments must be an object");
  }
  const input = args as Record<string, unknown>;
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary || summary.length > REPORT_PROGRESS_MAX_SUMMARY_LENGTH) {
    return errorResponse(
      null,
      -32602,
      `summary must contain 1-${REPORT_PROGRESS_MAX_SUMMARY_LENGTH} characters`,
    );
  }
  const status = input.status;
  if (status !== "in_progress" && status !== "completed") {
    return errorResponse(null, -32602, "status must be in_progress or completed");
  }
  return progressToolResult(summary, status);
}

/** Handle one MCP JSON-RPC message. Notifications intentionally return null. */
export function handleReportProgressMcpMessage(message: unknown): JsonRpcResponse | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return errorResponse(null, -32600, "invalid JSON-RPC request");
  }
  const request = message as JsonRpcRequest;
  const id = responseId(request.id);
  const method = typeof request.method === "string" ? request.method : "";

  if (!Object.prototype.hasOwnProperty.call(request, "id")) {
    return null;
  }
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "botcord-report-progress", version: "0.1.0" },
      },
    };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{
          name: REPORT_PROGRESS_TOOL_NAME,
          description:
            "Report one concise, user-visible execution update. Never include hidden reasoning, secrets, or raw tool output.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: {
                type: "string",
                minLength: 1,
                maxLength: REPORT_PROGRESS_MAX_SUMMARY_LENGTH,
                description: "A short factual update describing completed work or the next visible action.",
              },
              status: {
                type: "string",
                enum: [...REPORT_PROGRESS_STATUSES],
                description: "in_progress while working; completed after a meaningful phase finishes.",
              },
            },
            required: ["summary", "status"],
          },
        }],
      },
    };
  }
  if (method === "tools/call") {
    const result = toolCallResult(request.params);
    if (result && typeof result === "object" && "error" in result) {
      return { ...(result as JsonRpcResponse), id };
    }
    return { jsonrpc: "2.0", id, result };
  }
  if (
    method === "resources/list" ||
    method === "resources/templates/list" ||
    method === "prompts/list"
  ) {
    const key = method === "resources/list"
      ? "resources"
      : method === "resources/templates/list"
        ? "resourceTemplates"
        : "prompts";
    return { jsonrpc: "2.0", id, result: { [key]: [] } };
  }
  return errorResponse(id, -32601, `method not found: ${method}`);
}

export async function startReportProgressMcpServer(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response: JsonRpcResponse | null;
    try {
      response = handleReportProgressMcpMessage(JSON.parse(line));
    } catch {
      response = errorResponse(null, -32700, "parse error");
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && reportProgressMcpServerPath() === process.argv[1]) {
  void startReportProgressMcpServer();
}
