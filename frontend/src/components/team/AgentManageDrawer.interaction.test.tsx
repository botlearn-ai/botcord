// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DirectoryAgent } from "@/lib/team-access";
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/store/useConfirmStore", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("@/lib/team-spaces", async (original) => ({
  ...(await original<typeof import("@/lib/team-spaces")>()),
  teamSpacesApi: { removeAgent: mocks.remove },
}));
vi.mock("@/lib/anime", () => ({
  animateOverlayPanelEnter: () => null,
  animateOverlayPanelExit: (
    _a: unknown,
    _b: unknown,
    options: { onComplete: () => void },
  ) => {
    options.onComplete();
    return null;
  },
  cleanupAnime: vi.fn(),
}));
import AgentManageDrawer from "./AgentManageDrawer";
let container: HTMLDivElement;
let root: Root;
const agent = {
  agent_id: "agent-a",
  display_name: "Helper",
  my_access: "owner",
  status: "online",
  default_reply_mode: "mention_only",
  owner_name: "Owner",
} as DirectoryAgent;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.remove.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
it("keeps owner-only tabs unavailable to a non-owner manager", () => {
  act(() =>
    root.render(
      <AgentManageDrawer
        spaceId="org-a"
        agent={agent}
        isOwner={false}
        canRemove
        pending={4}
        users={[]}
        userId="me"
        initialTab="access"
        chatBusy={false}
        onChat={null}
        onChanged={vi.fn()}
        onRemoved={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(
    document.body
      .querySelector('[role="dialog"]')
      ?.closest("#dashboard-overlay-root")?.parentElement,
  ).toBe(document.body);
  const labels = [...document.body.querySelectorAll('[role="tab"]')].map(
    (node) => node.textContent,
  );
  expect(labels).toEqual(["概览", "危险操作"]);
  expect(
    document.body.querySelector('[role="tab"][aria-selected="true"]')
      ?.textContent,
  ).toBe("概览");
});
it("blocks closing during confirmed removal and reports failure without removing the Agent", async () => {
  let reject!: (error: Error) => void;
  mocks.remove.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const close = vi.fn(),
    removed = vi.fn();
  act(() =>
    root.render(
      <AgentManageDrawer
        spaceId="org-a"
        agent={agent}
        isOwner
        canRemove
        pending={0}
        users={[]}
        userId="me"
        initialTab="danger"
        chatBusy={false}
        onChat={null}
        onChanged={vi.fn()}
        onRemoved={removed}
        onClose={close}
      />,
    ),
  );
  const remove = [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("从组织移除"),
  )!;
  await act(async () => remove.click());
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ tone: "danger" }),
  );
  expect(mocks.remove).toHaveBeenCalledWith("org-a", "agent-a");
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    ),
  );
  expect(close).not.toHaveBeenCalled();
  expect(
    document.body.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!
      .disabled,
  ).toBe(true);
  await act(async () => reject(new Error("remove failed")));
  expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
  expect(removed).not.toHaveBeenCalled();
  expect(
    document.body.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!
      .disabled,
  ).toBe(false);
});
