// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  tree: vi.fn(),
  revisions: vi.fn(),
  page: vi.fn(),
  write: vi.fn(),
  approve: vi.fn(),
  revision: vi.fn(),
}));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/store/useConfirmStore", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/store/useToastStore", () => ({ toast: vi.fn() }));
vi.mock("@/lib/team-kb", async (original) => ({
  ...(await original<typeof import("@/lib/team-kb")>()),
  teamKbApi: mocks,
}));
import TeamKnowledgePage from "./TeamKnowledgePage";

let container: HTMLDivElement;
let root: Root;
const node = (path: string, kind: "dir" | "page", extra = {}) => ({
  node_id: path, path, kind, title: null, description: null, description_missing: true,
  description_source: null, tags: [], version: 1, pending: 0, size_bytes: 0,
  updated_by: "hu_me", updated_at: null, ...extra,
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.revisions.mockResolvedValue({ revisions: [] });
  mocks.page.mockReturnValue(new Promise(() => {}));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

it("offers a README when empty and submits members' edits as drafts", async () => {
  mocks.tree.mockResolvedValue({ nodes: [], can_publish: false });
  mocks.write.mockResolvedValue({ status: "proposed", revision_id: "kbr_1", node: node("/README.md", "page", { version: 0 }) });
  await act(async () => root.render(<TeamKnowledgePage spaceId="sp_1" />));
  await flush();
  expect(container.textContent).toContain("还没有知识页面");

  const create = [...container.querySelectorAll("button")].find((b) => b.textContent === "创建 README")!;
  await act(async () => create.click());
  expect(container.textContent).toContain("你的修改会作为草稿提交");
  const submit = [...container.querySelectorAll("button")].find((b) => b.textContent === "提交草稿")!;
  await act(async () => submit.click());
  await flush();
  expect(mocks.write).toHaveBeenCalledWith("sp_1", expect.objectContaining({ path: "/README.md" }));
  expect(mocks.write.mock.calls[0][1]).not.toHaveProperty("base_version");
});

it("shows the tree, page metadata and the pending review count", async () => {
  mocks.tree.mockResolvedValue({
    nodes: [node("/handbook", "dir"), node("/handbook/release.md", "page", { pending: 1 })],
    can_publish: true,
  });
  mocks.revisions.mockResolvedValue({ revisions: [{ revision_id: "kbr_1", path: "/handbook/release.md", author: "ag_barry" }] });
  mocks.page.mockResolvedValue({
    ...node("/handbook/release.md", "page", { title: "发布流程", description: "上线时读", description_source: "agent" }),
    summary: "旧摘要", summary_source: "agent", summary_stale: true, content: "# 发布流程",
    content_hash: "h", source_refs: [], created_by: "hu_me", pending_revisions: [],
  });
  await act(async () => root.render(<TeamKnowledgePage spaceId="sp_1" />));
  await flush();
  const pageButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("release.md"))!;
  await act(async () => pageButton.click());
  await flush();
  expect(mocks.page).toHaveBeenCalledWith("sp_1", "/handbook/release.md", expect.anything());
  const text = container.textContent ?? "";
  expect(text).toContain("上线时读");
  expect(text).toContain("agent 生成");
  expect(text).toContain("已过期");
  expect(text).toContain("待审核1");
});
