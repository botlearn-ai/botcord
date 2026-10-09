import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "user-token" } },
      }),
    },
  }),
}));
import { ApiError } from "./api";
import { spaceError } from "./team-spaces";
import {
  accessBadge,
  agentDefaultAccessApi,
  buildApproveInput,
  canChatWith,
  canRequestAccess,
  capabilityBadge,
  latestRequestByAgent,
  parseKeywords,
  pendingToDecide,
  replyModeHint,
  replyRulesApi,
  teamAccessApi,
  agentRowActions,
  agentStatusLabel,
  agentTabCounts,
  accessSummary,
  filterAgents,
  ownerAgentSummary,
  pendingCountFor,
  runtimeLabel,
  type AccessRequest,
  type DirectoryAgent,
} from "./team-access";

const now = new Date("2026-10-09T00:00:00.000Z");

describe("team access API", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), init: init as RequestInit, headers: new Headers(init.headers) };
  };

  it("loads the directory with user auth and no Agent actor", async () => {
    await teamAccessApi.directory("org-a");
    const { url, headers } = call();
    expect(url).toContain("/api/spaces/org-a/agent-directory");
    expect(headers.get("Authorization")).toBe("Bearer user-token");
    expect(headers.has("X-Active-Agent")).toBe(false);
  });
  it("requests access with a trimmed optional message", async () => {
    await teamAccessApi.requestAccess("org-a", "ag_x", "collaborator", "  need to fix bugs ");
    await teamAccessApi.requestAccess("org-a", "ag_x", "consultant", "   ");
    expect(call(0).url).toContain("/api/spaces/org-a/agents/ag_x/access-requests");
    expect(call(0).init.method).toBe("POST");
    expect(JSON.parse(String(call(0).init.body))).toEqual({ role: "collaborator", message: "need to fix bugs" });
    expect(JSON.parse(String(call(1).init.body))).toEqual({ role: "consultant" });
  });
  it("lists, approves, rejects and cancels requests in the space", async () => {
    await teamAccessApi.requests("org-a", "all");
    await teamAccessApi.approve("org-a", "req-1", { role: "consultant", expires_at: null });
    await teamAccessApi.reject("org-a", "req-1");
    await teamAccessApi.cancel("org-a", "req-1");
    expect(call(0).url).toContain("/api/spaces/org-a/access-requests?status=all");
    expect(call(1).url).toContain("/api/spaces/org-a/access-requests/req-1/approve");
    expect(JSON.parse(String(call(1).init.body))).toEqual({ role: "consultant", expires_at: null });
    expect(call(2).url).toContain("/access-requests/req-1/reject");
    expect(call(3).url).toContain("/access-requests/req-1/cancel");
    expect(call(3).init.method).toBe("POST");
  });
  it("reads room access, agent rooms and the admin overview", async () => {
    await teamAccessApi.roomAgentAccess("org-a", "rm_1");
    await teamAccessApi.agentRooms("org-a", "ag_x");
    await teamAccessApi.overview("org-a");
    expect(call(0).url).toContain("/api/spaces/org-a/rooms/rm_1/agent-access");
    expect(call(1).url).toContain("/api/spaces/org-a/agents/ag_x/rooms");
    expect(call(2).url).toContain("/api/spaces/org-a/access-overview");
  });
  it("puts and deletes per-sender reply rules scoped to a room", async () => {
    await replyRulesApi.put("ag_x", { sender_id: "hu_bob", room_id: "rm_1", attention_mode: "always" });
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 204 }));
    await replyRulesApi.remove("ag_x", "hu_bob", "rm_1");
    expect(call(0).url).toContain("/api/agents/ag_x/reply-rules");
    expect(call(0).init.method).toBe("PUT");
    expect(JSON.parse(String(call(0).init.body))).toEqual({
      sender_id: "hu_bob",
      room_id: "rm_1",
      attention_mode: "always",
    });
    expect(call(1).url).toContain("/api/agents/ag_x/reply-rules?sender_id=hu_bob&room_id=rm_1");
    expect(call(1).init.method).toBe("DELETE");
  });
  it("reads and patches the personal default capability", async () => {
    await agentDefaultAccessApi.get("ag_x");
    await agentDefaultAccessApi.set("ag_x", "full");
    expect(call(0).url).toContain("/api/agents/ag_x/access/relations");
    expect(call(1).init.method).toBe("PATCH");
    expect(JSON.parse(String(call(1).init.body))).toEqual({ capability: "full" });
  });
  it("surfaces request errors with readable messages", async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ detail: "access_already_granted" }), { status: 409 }),
    );
    const error = await teamAccessApi.requestAccess("org-a", "ag_x", "consultant").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(spaceError(error, true)).toBe("你已经有这个权限了，刷新后即可使用。");
    expect(spaceError(new ApiError(422, "cannot_request_own_agent"), false)).toContain("your own Agent");
  });
});

describe("team access helpers", () => {
  it("labels what I can do in plain language", () => {
    expect(accessBadge("owner", true).label).toBe("所有者");
    expect(accessBadge("collaborator", true)).toMatchObject({
      label: "协作",
      explanation: "在单独的分支里改代码，不会动所有者的原始代码。",
    });
    expect(accessBadge("consultant", false)).toMatchObject({
      label: "Read-only",
      explanation: "Can only answer questions and read files.",
    });
    expect(accessBadge("none", true).label).toBe("无权限");
    expect(capabilityBadge("full", true)).toMatchObject({ label: "完整", tone: "full" });
    expect(capabilityBadge("consult", true).label).toBe("只读");
  });
  it("offers requests for no access or a read-only upgrade, chat for any access", () => {
    expect(canRequestAccess({ my_access: "none" })).toBe(true);
    expect(canRequestAccess({ my_access: "consultant" })).toBe(true);
    expect(canRequestAccess({ my_access: "collaborator" })).toBe(false);
    expect(canRequestAccess({ my_access: "owner" })).toBe(false);
    expect(canChatWith({ my_access: "none" })).toBe(false);
    expect(canChatWith({ my_access: "consultant" })).toBe(true);
  });
  it("builds composer hints only for restricted reply modes", () => {
    expect(replyModeHint("Barry", "always", [], true)).toBeNull();
    expect(replyModeHint("Barry", "mention_only", [], true)).toBe("Barry 只在被 @ 时回复");
    expect(replyModeHint("Barry", "keyword", ["部署", "发布"], true)).toBe(
      "Barry 只在提到关键词 部署、发布 时回复",
    );
    expect(replyModeHint("Barry", "keyword", ["deploy"], false)).toBe(
      "Barry only replies when you mention deploy",
    );
  });
  it("parses keywords from mixed separators", () => {
    expect(parseKeywords("deploy, 发布，上线、deploy\n ")).toEqual(["deploy", "发布", "上线"]);
  });
  it("sends workspace and commands only when approving collaborators", () => {
    const base = { duration: "1d" as const, workspacePath: " ~/repo ", commands: "npm test", now };
    expect(buildApproveInput({ ...base, role: "consultant" })).toEqual({
      role: "consultant",
      expires_at: "2026-10-10T00:00:00.000Z",
    });
    expect(buildApproveInput({ ...base, role: "collaborator", duration: "none" })).toEqual({
      role: "collaborator",
      expires_at: null,
      workspace_path: "~/repo",
      allowed_commands: ["npm test"],
    });
  });
  it("picks pending requests per agent and my latest request per agent", () => {
    const req = (id: string, agent: string, status: AccessRequest["status"], at: string) =>
      ({ id, agent_id: agent, status, created_at: at }) as AccessRequest;
    const requests = {
      to_decide: [req("1", "ag_a", "pending", "2026-10-01"), req("2", "ag_b", "rejected", "2026-10-02")],
      mine: [],
    };
    expect(pendingToDecide(requests).map((r) => r.id)).toEqual(["1"]);
    expect(pendingToDecide(requests, "ag_b")).toEqual([]);
    const latest = latestRequestByAgent([
      req("old", "ag_a", "rejected", "2026-10-01T00:00:00Z"),
      req("new", "ag_a", "cancelled", "2026-10-03T00:00:00Z"),
    ]);
    expect(latest.ag_a.id).toBe("new");
  });
});

describe("Team Agent page helpers", () => {
  const agent = (id: string, my_access: DirectoryAgent["my_access"], extra: Partial<DirectoryAgent> = {}) =>
    ({
      agent_id: id,
      display_name: id,
      owner_name: "Owner",
      my_access,
      grant_id: null,
      pending_request: null,
      default_reply_mode: "mention_only",
      avatar_url: null,
      runtime: null,
      hosting_kind: null,
      status: "online",
      room_count: 0,
      grant_count: my_access === "owner" ? 0 : null,
      pending_request_count: my_access === "owner" ? 0 : null,
      ...extra,
    }) as DirectoryAgent;
  const pending = (agentId: string) => ({ id: `r-${agentId}`, agent_id: agentId }) as AccessRequest;
  const agents = [
    agent("zeta", "none"),
    agent("mine-b", "owner", { pending_request_count: 2 }),
    agent("mine-a", "owner"),
    agent("collab", "collaborator"),
    agent("reader", "consultant"),
  ];

  it("counts tabs from the live request list, falling back to the directory", () => {
    expect(agentTabCounts(agents, null)).toEqual({ all: 5, mine: 2, available: 2, action: 1 });
    // Once loaded, the store wins: mine-b's requests were decided, mine-a got one.
    expect(agentTabCounts(agents, [pending("mine-a")])).toEqual({ all: 5, mine: 2, available: 2, action: 1 });
    expect(agentTabCounts(agents, [])).toMatchObject({ action: 0 });
    // Requests on Agents I don't own never count.
    expect(pendingCountFor(agents[0], [pending("zeta")])).toBe(0);
    expect(pendingCountFor(agents[2], [pending("mine-a"), pending("mine-a")])).toBe(2);
  });
  it("filters by tab and orders mine, usable, then the rest by name", () => {
    expect(filterAgents(agents, "all", null).map((a) => a.agent_id)).toEqual([
      "mine-a",
      "mine-b",
      "collab",
      "reader",
      "zeta",
    ]);
    expect(filterAgents(agents, "mine", null).map((a) => a.agent_id)).toEqual(["mine-a", "mine-b"]);
    expect(filterAgents(agents, "available", null).map((a) => a.agent_id)).toEqual(["collab", "reader"]);
    expect(filterAgents(agents, "action", null).map((a) => a.agent_id)).toEqual(["mine-b"]);
  });
  it("chooses row actions by what the viewer may do", () => {
    expect(agentRowActions(agent("x", "owner"))).toEqual(["chat", "manage"]);
    expect(agentRowActions(agent("x", "collaborator"))).toEqual(["chat"]);
    expect(agentRowActions(agent("x", "consultant"))).toEqual(["upgrade", "chat"]);
    expect(agentRowActions(agent("x", "none"))).toEqual(["request"]);
    const asked = { id: "r", requested_role: "collaborator" as const };
    expect(agentRowActions(agent("x", "none", { pending_request: asked }))).toEqual(["cancel"]);
    expect(agentRowActions(agent("x", "consultant", { pending_request: asked }))).toEqual(["cancel", "chat"]);
  });
  it("labels status, runtime and summaries in plain language", () => {
    expect(agentStatusLabel("working", true)).toBe("工作中");
    expect(agentStatusLabel("away", false)).toBe("Away");
    expect(runtimeLabel("claude-code")).toBe("Claude Code");
    expect(runtimeLabel("codex", "daemon")).toBe("Codex");
    expect(runtimeLabel("custom-cli")).toBe("custom-cli");
    expect(runtimeLabel(null, "cloud")).toBe("Cloud");
    expect(runtimeLabel(null, "daemon")).toBeNull();
    expect(ownerAgentSummary({ grant_count: 2, room_count: 3, default_reply_mode: "mention_only" }, true)).toBe(
      "2 人可用 · 在 3 个房间 · 只在被 @ 时",
    );
    expect(ownerAgentSummary({ grant_count: 1, room_count: 1, default_reply_mode: "always" }, false)).toBe(
      "1 person has access · in 1 room · Every message",
    );
    expect(accessSummary("consultant", true)).toBe("你可以：回答问题、读取文件");
    expect(accessSummary("none", false)).toContain("Ask the owner");
  });
});
