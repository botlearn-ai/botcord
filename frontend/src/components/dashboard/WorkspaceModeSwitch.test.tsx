// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch";

const locale = vi.hoisted(() => ({ value: "en" }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => locale.value }));
afterEach(() => { locale.value = "en"; });

it.each([false, true])("preserves destinations and identifies the current workspace (team=%s)", (teamMode) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<WorkspaceModeSwitch teamMode={teamMode} personalHref="/chats?tab=bots" teamHref="/chats/team?space=example" />);
  const links = [...host.querySelectorAll("a")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/chats?tab=bots", "/chats/team?space=example"]);
  expect(links.map((link) => link.getAttribute("aria-current"))).toEqual(teamMode ? [null, "page"] : ["page", null]);
  expect(links.every((link) => !link.hasAttribute("aria-pressed"))).toBe(true);
});

it("localizes both workspace labels and the navigation landmark", () => {
  locale.value = "zh";
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<WorkspaceModeSwitch teamMode personalHref="/chats" />);
  expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe("工作模式");
  expect([...host.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["个人", "团队"]);
  expect(host.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
});

it("provides the default Team destination before joining an organization", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<WorkspaceModeSwitch teamMode={false} personalHref="/chats/messages/room" />);
  expect(host.querySelector('a[href="/chats/team"]')).not.toBeNull();
  expect(host.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/chats/messages/room");
});
