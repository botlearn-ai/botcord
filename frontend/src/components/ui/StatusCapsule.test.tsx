// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import StatusCapsule from "./StatusCapsule";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

it("renders avatar, name, status and actions", () => {
  let allowed = false;
  const { host, root } = render(
    <StatusCapsule
      avatar={<span data-testid="avatar" />}
      name="Wallet Ops"
      status="等待你授权转账 12.00"
      actions={<button type="button" onClick={() => { allowed = true; }}>允许</button>}
      className="extra"
    />,
  );
  const capsule = host.firstElementChild!;
  expect(capsule.className).toContain("h-10");
  expect(capsule.className).toContain("rounded-full");
  expect(capsule.className).toContain("extra");
  expect(host.querySelector('[data-testid="avatar"]')).not.toBeNull();
  expect(host.textContent).toContain("Wallet Ops");
  expect(host.textContent).toContain("等待你授权转账 12.00");
  act(() => host.querySelector("button")!.click());
  expect(allowed).toBe(true);
  act(() => root.unmount());
});

it("uses the 32px height when compact and omits the action slot without actions", () => {
  const { host, root } = render(<StatusCapsule compact avatar={null} name="Atlas" status="空闲" />);
  const capsule = host.firstElementChild!;
  expect(capsule.className).toContain("h-8");
  expect(capsule.className).not.toContain("h-10");
  expect(host.querySelector(".ml-auto")).toBeNull();
  expect(host.textContent).toContain("空闲");
  act(() => root.unmount());
});
