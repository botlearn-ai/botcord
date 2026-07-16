import { describe, expect, it } from "vitest";
import {
  handleReportProgressMcpMessage,
  REPORT_PROGRESS_MAX_SUMMARY_LENGTH,
} from "../mcp/report-progress-server.js";

describe("report_progress MCP server", () => {
  it("advertises one bounded progress tool", () => {
    const response = handleReportProgressMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    expect(response).toMatchObject({
      id: 1,
      result: {
        tools: [{
          name: "report_progress",
          inputSchema: {
            additionalProperties: false,
            required: ["summary", "status"],
          },
        }],
      },
    });
  });

  it("returns a structured acknowledgement for a valid report", () => {
    const response = handleReportProgressMcpMessage({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: {
        name: "report_progress",
        arguments: { summary: "已读取项目结构，正在检查测试入口。", status: "in_progress" },
      },
    });

    const text = (response as any).result.content[0].text;
    expect(JSON.parse(text)).toEqual({
      schemaVersion: "tool-result/0.1",
      ok: true,
      code: "progress_reported",
      data: { summary: "已读取项目结构，正在检查测试入口。", status: "in_progress" },
      evidence: [],
    });
  });

  it("rejects invalid status and oversized summaries", () => {
    const invalidStatus = handleReportProgressMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "report_progress",
        arguments: { summary: "working", status: "done" },
      },
    });
    expect(invalidStatus).toMatchObject({ id: 2, error: { code: -32602 } });

    const oversized = handleReportProgressMcpMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "report_progress",
        arguments: { summary: "x".repeat(REPORT_PROGRESS_MAX_SUMMARY_LENGTH + 1), status: "completed" },
      },
    });
    expect(oversized).toMatchObject({ id: 3, error: { code: -32602 } });
  });

  it("does not reply to notifications", () => {
    expect(handleReportProgressMcpMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })).toBeNull();
  });
});
