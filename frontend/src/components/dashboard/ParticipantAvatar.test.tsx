// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import ParticipantAvatar from "./ParticipantAvatar";

it("uses a human profile photo, falls back on errors, and retries a changed photo", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (url?: string) => act(() => root.render(<ParticipantAvatar id="hu_alice" name="张三" isHuman avatarUrl={url} />));
  try {
    await render("/alice.png");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/alice.png");
    await act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("张");
    expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("张三");
    await render("/alice-new.png");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/alice-new.png");
    await render();
    expect(host.textContent).toBe("张");
    await act(() => root.render(<ParticipantAvatar id="ag_bot" name="Helper" isHuman={false} />));
    expect(host.querySelector("img")?.getAttribute("src")).toMatch(/^\/avatars\/bots\//);
  } finally {
    await act(() => root.unmount());
  }
});
