// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import BotAvatar from "./BotAvatar";
import ParticipantAvatar from "./ParticipantAvatar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("preserves legacy pixel sizes, custom images and accessible names", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<BotAvatar agentId="ag_test" avatarUrl="/custom.svg" alt="Researcher" size={40} className="mt-2" shape="rounded" />));
  expect(host.querySelector("img")?.getAttribute("src")).toBe("/custom.svg");
  expect(host.querySelector("img")?.getAttribute("alt")).toBe("Researcher");
  expect((host.firstElementChild as HTMLElement).style.width).toBe("40px");
  expect(host.firstElementChild?.classList.contains("mt-2")).toBe(true);
  act(() => root.render(<ParticipantAvatar id="human" name="Alice" isHuman size={24} avatarUrl="/broken.svg" />));
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Alice");
  expect(host.textContent).toBe("A");
  expect((host.firstElementChild as HTMLElement).style.width).toBe("24px");
  act(() => root.unmount());
});
