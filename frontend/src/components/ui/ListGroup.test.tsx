// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import ListGroup, { ListGroupItem } from "./ListGroup";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
function mount(content: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(content)); return host;
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

it("keeps list semantics and toggles dividers", () => {
  const host = mount(<><ListGroup aria-label="Requests"><ListGroupItem>A</ListGroupItem><ListGroupItem align="start">B</ListGroupItem></ListGroup><ListGroup divided={false}><ListGroupItem>C</ListGroupItem></ListGroup></>);
  const [divided, plain] = Array.from(host.querySelectorAll("ul"));
  expect(divided.getAttribute("aria-label")).toBe("Requests");
  expect(divided.className).toContain("divide-y");
  expect(plain.className).not.toContain("divide-y");
  const items = divided.querySelectorAll("li");
  expect(items[0].className).toContain("items-center");
  expect(items[1].className).toContain("items-start");
});
