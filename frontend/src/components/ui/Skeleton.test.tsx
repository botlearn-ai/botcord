// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import Skeleton from "./Skeleton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}

it("reuses the global skeleton animation and is hidden from assistive tech", () => {
  const { host, root } = setup();
  act(() => root.render(<Skeleton className="extra" />));
  const block = host.firstElementChild as HTMLElement;
  expect(block.getAttribute("aria-hidden")).toBe("true");
  expect(block.className).toContain("dashboard-skeleton-block");
  expect(block.className).toContain("rounded");
  expect(block.className).toContain("extra");
  act(() => root.unmount());
});

it("sizes blocks and keeps circles round from a single dimension", () => {
  const { host, root } = setup();
  act(() => root.render(<Skeleton shape="block" width="50%" height={80} />));
  let block = host.firstElementChild as HTMLElement;
  expect(block.className).toContain("rounded-xl");
  expect(block.style.width).toBe("50%");
  expect(block.style.height).toBe("80px");

  act(() => root.render(<Skeleton shape="circle" width={40} />));
  block = host.firstElementChild as HTMLElement;
  expect(block.className).toContain("rounded-full");
  expect(block.style.width).toBe("40px");
  expect(block.style.height).toBe("40px");
  act(() => root.unmount());
});
