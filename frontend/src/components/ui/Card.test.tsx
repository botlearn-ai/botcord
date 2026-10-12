// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import Card from "./Card";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}

it("renders a default div card with surface, border and md padding", () => {
  const { host, root } = setup();
  act(() => root.render(<Card className="extra" data-testid="card">Body</Card>));
  const card = host.firstElementChild!;
  expect(card.tagName).toBe("DIV");
  expect(card.className).toContain("rounded-xl");
  expect(card.className).toContain("bg-surface");
  expect(card.className).toContain("border-border");
  expect(card.className).toContain("p-4");
  expect(card.className).toContain("extra");
  expect(card.getAttribute("data-testid")).toBe("card");
  act(() => root.unmount());
});

it("renders as a semantic element with variant and padding", () => {
  const { host, root } = setup();
  act(() => root.render(<Card as="section" variant="sunken" padding="none" aria-label="Stats" />));
  const card = host.firstElementChild!;
  expect(card.tagName).toBe("SECTION");
  expect(card.className).toContain("bg-surface-sunken");
  expect(card.className).not.toContain("p-4");
  expect(card.getAttribute("type")).toBeNull();
  act(() => root.unmount());
});

it("renders an interactive button card with type=button and forwards clicks and refs", () => {
  const { host, root } = setup();
  let clicks = 0;
  const ref = React.createRef<HTMLElement>();
  act(() => root.render(
    <Card as="button" variant="interactive" ref={ref} onClick={() => { clicks += 1; }}>Open</Card>,
  ));
  const card = host.querySelector("button")!;
  expect(card.getAttribute("type")).toBe("button");
  expect(card.className).toContain("focus-visible:ring-2");
  expect(card.className).toContain("hover:border-border-strong");
  expect(ref.current).toBe(card);
  act(() => card.click());
  expect(clicks).toBe(1);

  act(() => root.render(<Card as="button" type="submit" disabled>Save</Card>));
  expect(host.querySelector("button")!.getAttribute("type")).toBe("submit");
  expect(host.querySelector("button")!.disabled).toBe(true);
  act(() => root.unmount());
});
