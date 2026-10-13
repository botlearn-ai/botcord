// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfileEditor } from "./BotDetailDrawer";
import { botDetailDrawer } from "@/lib/i18n/translations/dashboard";
import { useToastStore } from "@/store/useToastStore";
import { userApi } from "@/lib/api";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

let container: HTMLDivElement;
let root: Root;
const save = vi.spyOn(userApi, "updateAgent");
const props = {
  t: botDetailDrawer.en, agentId: "ag_test", initialName: "Test Bot", initialBio: "",
};
function render(overrides: Partial<typeof props> = {}) {
  const next = { ...props, ...overrides };
  act(() => root.render(<ProfileEditor key={next.agentId} {...next} />));
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(el => el.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function change(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  act(() => {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  save.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useDashboardSessionStore.setState({ ownedAgents: [{
    agent_id: "ag_test", display_name: "Test Bot", bio: "", is_default: true, claimed_at: "", ws_online: false,
  }], user: null });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("opens as readable profile without inputs or a Save action", () => {
  render();
  expect(container.textContent).not.toContain("Test Bot");
  expect(container.textContent).toContain("No bio yet");
  expect(container.querySelector("input, textarea")).toBeNull();
  expect(container.textContent).not.toContain("Save");
  expect(save).not.toHaveBeenCalled();
});

it("enters edit explicitly and discards cancelled changes", async () => {
  render();
  await click("Edit profile");
  expect(document.activeElement).toBe(container.querySelector("input"));
  change("input", "Unsaved");
  change("textarea", "Draft bio");
  await click("Cancel");
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).not.toContain("Test Bot");
  expect(container.textContent).not.toContain("Unsaved");
  await click("Edit profile");
  expect(container.querySelector("input")!.value).toBe("Test Bot");
  expect(container.querySelector("textarea")!.value).toBe("");
  expect(save).not.toHaveBeenCalled();
});

it("saves trimmed values, updates other Bot surfaces and returns to display mode", async () => {
  save.mockResolvedValue({ agent_id: "ag_test", display_name: "Renamed", bio: "New bio", avatar_url: null, is_default: true, claimed_at: null });
  render();
  await click("Edit profile");
  change("input", " Renamed ");
  change("textarea", " New bio ");
  await click("Save");
  expect(save).toHaveBeenCalledWith("ag_test", { display_name: "Renamed", bio: "New bio" });
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).toContain("New bio");
  expect(useToastStore.getState().toasts.at(-1)?.title).toBe("Saved");
  expect(useDashboardSessionStore.getState().ownedAgents[0].display_name).toBe("Renamed");
  await click("Edit profile");
  expect(container.querySelector("input")!.value).toBe("Renamed");
});

it("keeps edits available on save failure", async () => {
  save.mockRejectedValue(new Error("Network unavailable"));
  render();
  await click("Edit profile");
  change("input", "Retry name");
  await click("Save");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable");
  expect(container.querySelector("input")!.value).toBe("Retry name");
  await click("Cancel");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("disables saving an unchanged or blank name", async () => {
  render();
  await click("Edit profile");
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit.disabled).toBe(true);
  change("input", "   ");
  expect(submit.disabled).toBe(true);
  await click("Save");
  expect(save).not.toHaveBeenCalled();
});

it("opens a different Bot in display mode with no previous draft", async () => {
  render();
  await click("Edit profile");
  change("input", "Do not carry this draft");
  render({ agentId: "ag_other", initialName: "Other Bot", initialBio: "Other bio" });
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).toContain("Other bio");
  expect(container.textContent).not.toContain("Do not carry");
});

it("adds a bio explicitly and reports editing state to the overview", async () => {
  const onEditingChange = vi.fn();
  act(() => root.render(<ProfileEditor {...props} onEditingChange={onEditingChange} />));
  expect(container.textContent).not.toContain(props.agentId);
  await click("Add a bio");
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  expect(container.textContent).not.toContain(props.agentId);
  await click("Cancel");
  expect(onEditingChange).toHaveBeenLastCalledWith(false);
});
