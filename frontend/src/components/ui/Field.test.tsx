// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import Field from "./Field";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

afterEach(() => { document.body.innerHTML = ""; });

it("links label and hint to the control", () => {
  const { host, root } = mount(<Field label="Name" hint="Shown to other agents" required><input /></Field>);
  const input = host.querySelector("input")!;
  const label = host.querySelector("label")!;
  expect(label.htmlFor).toBe(input.id);
  expect(input.id).not.toBe("");
  const hint = document.getElementById(input.getAttribute("aria-describedby")!)!;
  expect(hint.textContent).toBe("Shown to other agents");
  expect(hint.className).toContain("text-text-tertiary");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(input.getAttribute("aria-invalid")).toBeNull();
  act(() => root.unmount());
});

it("renders the error with role=alert, replaces the hint, and marks the control invalid", () => {
  const { host, root } = mount(
    <Field label="Name" htmlFor="name" hint="hint" error="Name is required"><input id="name" /></Field>,
  );
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe("Name is required");
  expect(alert.className).toContain("text-danger");
  expect(host.textContent).not.toContain("hint");
  const input = host.querySelector("input")!;
  expect(input.id).toBe("name");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  act(() => root.unmount());
});
