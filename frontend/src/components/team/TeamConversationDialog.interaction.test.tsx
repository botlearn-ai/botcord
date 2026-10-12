// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpaceAgent, SpaceUser } from "@/lib/team-spaces";
const api = vi.hoisted(() => ({ create: vi.fn(), openDm: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/lib/anime", () => ({
  animateOverlayPanelEnter: (
    _a: unknown,
    _b: unknown,
    options?: { onComplete?: () => void },
  ) => {
    options?.onComplete?.();
    return null;
  },
  animateOverlayPanelExit: (
    _a: unknown,
    _b: unknown,
    options?: { onComplete?: () => void },
  ) => {
    options?.onComplete?.();
    return null;
  },
  cleanupAnime: vi.fn(),
}));
vi.mock("@/lib/org-rooms", async (original) => ({
  ...(await original<typeof import("@/lib/org-rooms")>()),
  orgRoomsApi: api,
}));
import TeamConversationDialog from "./TeamConversationDialog";
let container: HTMLDivElement;
let root: Root;
const users = [
  { id: "member-a", user_id: "other", status: "active", display_name: "Alice" },
] as SpaceUser[];
const agents = [
  { agent_id: "agent-a", status: "active", display_name: "Assistant" },
] as SpaceAgent[];
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.create.mockReset();
  api.openDm.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function change(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    control instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
    control,
    value,
  );
  control.dispatchEvent(
    new Event(control instanceof HTMLInputElement ? "input" : "change", {
      bubbles: true,
    }),
  );
}
it("submits a private room through the shared button and preserves selected members and Agents", async () => {
  api.create.mockResolvedValue({ room_id: "room-a" });
  const created = vi.fn();
  act(() =>
    root.render(
      <TeamConversationDialog
        spaceId="org-a"
        userId="me"
        kind="room"
        users={users}
        agents={agents}
        onClose={vi.fn()}
        onCreated={created}
      />,
    ),
  );
  act(() => {
    change(
      document.body.querySelector(
        'input:not([type="checkbox"]):not([type="radio"])',
      )!,
      "Planning",
    );
    change(document.body.querySelector("select")!, "private");
  });
  act(() => {
    document.body
      .querySelector<HTMLInputElement>('input[name="member"]')!
      .click();
    document.body
      .querySelector<HTMLInputElement>('input[name="agent"]')!
      .click();
  });
  expect(document.body.querySelector("label label")).toBeNull();
  await act(async () =>
    document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click(),
  );
  expect(api.create).toHaveBeenCalledWith("org-a", {
    name: "Planning",
    visibility: "private",
    member_ids: ["member-a"],
    agent_ids: ["agent-a"],
  });
  expect(created).toHaveBeenCalledWith({ room_id: "room-a", kind: "room" });
});
it("keeps a pending DM modal open and preserves the member selection when the request fails", async () => {
  let reject!: (reason: Error) => void;
  api.openDm.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const close = vi.fn();
  act(() =>
    root.render(
      <TeamConversationDialog
        spaceId="org-a"
        userId="me"
        kind="dm"
        users={users}
        onClose={close}
        onCreated={vi.fn()}
      />,
    ),
  );
  act(() =>
    document.body
      .querySelector<HTMLInputElement>('input[type="radio"]')!
      .click(),
  );
  await act(async () =>
    document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click(),
  );
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(close).not.toHaveBeenCalled();
  expect(api.openDm).toHaveBeenCalledTimes(1);
  expect(api.openDm).toHaveBeenCalledWith("org-a", "member-a");
  await act(async () => reject(new Error("network failed")));
  expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
  expect(
    document.body.querySelector<HTMLInputElement>('input[type="radio"]')!
      .checked,
  ).toBe(true);
  expect(
    document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!
      .disabled,
  ).toBe(false);
});

it("portals outside transformed workspace ancestors and restores the trigger focus on unmount", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  container.style.transform = "translateX(0)";
  container.style.overflow = "hidden";
  act(() =>
    root.render(
      <TeamConversationDialog
        spaceId="org-a"
        userId="me"
        kind="dm"
        users={users}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    ),
  );
  const modal = document.body.querySelector('[role="dialog"]')!;
  expect(modal.closest("#dashboard-overlay-root")?.parentElement).toBe(
    document.body,
  );
  expect(container.contains(modal)).toBe(false);
  expect(document.body.style.overflow).toBe("hidden");
  act(() => root.render(null));
  expect(document.body.style.overflow).not.toBe("hidden");
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});
