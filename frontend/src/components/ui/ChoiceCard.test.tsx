// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ChoiceCard from "./ChoiceCard";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
function mount(content: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(content)); return host;
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

it("acts as a native radio group with checked and disabled states", () => {
  const onChange = vi.fn();
  const host = mount(<form><fieldset><legend>Role</legend>
    <ChoiceCard name="role" value="consultant" title="Consultant" description="Ask questions" checked onChange={onChange} />
    <ChoiceCard name="role" value="collaborator" title="Collaborator" checked={false} onChange={onChange} />
    <ChoiceCard name="role" value="full" title="Full" checked={false} disabled onChange={onChange} />
  </fieldset></form>);
  const labels = host.querySelectorAll("label");
  expect(labels[0].className).toContain("bg-accent-soft");
  expect(labels[0].textContent).toContain("Ask questions");
  expect(labels[2].className).toContain("cursor-not-allowed");
  expect(new FormData(host.querySelector("form")!).get("role")).toBe("consultant");
  act(() => labels[1].click());
  expect(onChange).toHaveBeenCalledTimes(1);
  act(() => labels[2].click());
  expect(onChange).toHaveBeenCalledTimes(1);
});
