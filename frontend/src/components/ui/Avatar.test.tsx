// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { getBotAvatarUrl } from "@/lib/bot-avatars";
import Avatar from "./Avatar";
import type { AvatarProps } from "./Avatar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (props: AvatarProps) => act(() => root.render(<Avatar {...props} />));
  return { host, root, render };
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("uses the default pool avatar for agents without an image and falls back to it on error", () => {
  const { host, root, render } = setup();
  render({ kind: "agent", id: "ag_bot", name: "Helper" });
  const img = host.querySelector("img")!;
  expect(img.getAttribute("src")).toBe(getBotAvatarUrl("ag_bot"));
  expect(img.getAttribute("src")).toMatch(/^\/agent-avatars\/[a-z]+-[a-z]+\.svg$/);
  expect(img.getAttribute("alt")).toBe("Helper");
  expect(img.className).toContain("rounded-full");

  render({ kind: "agent", id: "ag_bot", name: "Helper", src: "/custom.png" });
  expect(host.querySelector("img")!.getAttribute("src")).toBe("/custom.png");
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")!.getAttribute("src")).toBe(getBotAvatarUrl("ag_bot"));
  act(() => root.unmount());
});

it("falls back to initials when a human image fails and retries a changed image", () => {
  const { host, root, render } = setup();
  render({ kind: "human", id: "hu_alice", name: "张三", src: "/alice.png" });
  expect(host.querySelector("img")!.className).toContain("rounded-[30%]");
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")).toBeNull();
  const initials = host.querySelector('[role="img"]')!;
  expect(initials.textContent).toBe("张");
  expect(initials.getAttribute("aria-label")).toBe("张三");
  expect(initials.className).toContain("bg-accent-soft");
  expect(initials.className).toContain("text-accent-text");

  render({ kind: "human", id: "hu_alice", name: "张三", src: "/alice-new.png" });
  expect(host.querySelector("img")!.getAttribute("src")).toBe("/alice-new.png");
  render({ kind: "human", id: "hu_alice", name: "  bob" });
  expect(host.textContent).toBe("B");
  act(() => root.unmount());
});

it("renders rooms as 24% rounded squares with initials", () => {
  const { host, root, render } = setup();
  render({ kind: "room", id: "rm_design", name: "design review", size: "xl" });
  const initials = host.querySelector('[role="img"]')!;
  expect(initials.textContent).toBe("D");
  expect(initials.className).toContain("rounded-[24%]");
  expect(host.firstElementChild!.className).toContain("h-16 w-16");
  act(() => root.unmount());
});

it("shows the status dot only for agents", () => {
  const { host, root, render } = setup();
  render({ kind: "agent", id: "ag_bot", name: "Helper", status: "thinking" });
  expect(host.querySelector('[aria-label="thinking"]')).not.toBeNull();
  expect(host.querySelector(".bc-avatar-orbit")).toBeNull();

  render({ kind: "agent", id: "ag_bot", name: "Helper", status: "replying" });
  expect(host.querySelector('[aria-label="replying"]')).not.toBeNull();
  expect(host.querySelector(".bc-avatar-orbit")?.getAttribute("aria-hidden")).toBe("true");

  render({ kind: "human", id: "hu_alice", name: "Alice", status: "online" });
  expect(host.querySelector('[aria-label="online"]')).toBeNull();
  render({ kind: "room", id: "rm_x", name: "Room", status: "online" });
  expect(host.querySelector('[aria-label="online"]')).toBeNull();
  act(() => root.unmount());
});
