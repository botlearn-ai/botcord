// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Select from "./Select";
import SingleSelect from "./SingleSelect";
import MultiSelect from "./MultiSelect";
import Alert from "./Alert";
import Radio from "./Radio";
import IconButton from "./IconButton";
import DrawerShell from "./DrawerShell";
import Table, { TableHead, TableBody, TableRow, TableHeader, TableCell } from "./Table";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("@/lib/anime", () => ({
  animatePop: () => null, animateIfMotion: () => null, animeStagger: () => 0, cleanupAnime: () => {}, prefersReducedMotion: () => true,
  animateOverlayPanelEnter: () => null,
  animateOverlayPanelExit: (_a: unknown, _b: unknown, options: { onComplete: () => void }) => { options.onComplete(); return null; },
}));
let root: ReturnType<typeof createRoot>;
function mount(content: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(content)); return host;
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const key = (element: Element, key: string) => act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

it("preserves native select and radio values in form submission", () => {
  const host = mount(<form><Select name="mode" defaultValue="all" required><option value="all">All</option></Select><Radio name="role" value="owner" defaultChecked /><Select name="disabled" disabled defaultValue="x"><option value="x">X</option></Select></form>);
  const data = new FormData(host.querySelector("form")!);
  expect(data.get("mode")).toBe("all"); expect(data.get("role")).toBe("owner"); expect(data.has("disabled")).toBe(false);
});
it("single selection skips disabled options with the keyboard and returns focus", () => {
  function Harness() { const [value, setValue] = useState<string | null>(null); return <SingleSelect value={value} onChange={setValue} placeholder="Pick" options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta", disabled: true }, { value: "c", label: "Gamma" }]} />; }
  const host = mount(<Harness />); const trigger = host.querySelector("button")!;
  act(() => trigger.click()); const options = host.querySelectorAll<HTMLButtonElement>('[role="option"]');
  options[0].focus(); key(options[0], "ArrowDown"); expect(document.activeElement).toBe(options[2]);
  act(() => options[2].click()); expect(host.querySelector('[role="listbox"]')).toBeNull(); expect(trigger.textContent).toContain("Gamma"); expect(document.activeElement).toBe(trigger);
});
it("multi selection filters options, toggles values and clears them", () => {
  function Harness() { const [value, setValue] = useState<string[]>([]); return <MultiSelect value={value} onChange={setValue} options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} placeholder="Agents" searchPlaceholder="Search agents" emptyLabel="None" />; }
  const host = mount(<Harness />); const trigger = host.querySelector("button")!; act(() => trigger.click());
  act(() => host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(host.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
  const input = host.querySelector("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Beta"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(host.querySelector('[role="option"]')?.textContent).toContain("Beta");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Clear selected"]')!.click());
  expect(trigger.textContent).toContain("0 selected"); key(input, "Escape"); expect(document.activeElement).toBe(trigger);
});
it("uses appropriate live roles and honours disabled icon actions", () => {
  const click = vi.fn(); const host = mount(<><Alert tone="danger">Failed</Alert><Alert tone="success">Saved</Alert><IconButton label="Delete" disabled onClick={click}>X</IconButton></>);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Failed"); expect(host.querySelector('[role="status"]')?.textContent).toContain("Saved");
  act(() => host.querySelector("button")!.click()); expect(click).not.toHaveBeenCalled(); expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Delete");
});
it("preserves table caption, column scope and spanning cells", () => {
  const host = mount(<Table><caption>Agents</caption><TableHead><TableRow><TableHeader>Name</TableHeader></TableRow></TableHead><TableBody><TableRow><TableCell colSpan={2}>None</TableCell></TableRow></TableBody></Table>);
  expect(host.querySelector("caption")?.textContent).toBe("Agents"); expect(host.querySelector("th")?.scope).toBe("col"); expect(host.querySelector("td")?.colSpan).toBe(2);
});
it("drawer keeps shared busy dismissal semantics", () => {
  const close = vi.fn(); const host = mount(<DrawerShell title="Agent" busy onClose={close}>Details</DrawerShell>);
  key(window as unknown as Element, "Escape"); expect(close).not.toHaveBeenCalled();
  act(() => root.render(<DrawerShell title="Agent" onClose={close}>Details</DrawerShell>));
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
  key(window as unknown as Element, "Escape"); expect(close).toHaveBeenCalledOnce();
});

it("keeps Tab inside the drawer and restores focus after unmount", () => {
  const host = mount(<button id="launch">Open</button>);
  const launch = host.querySelector<HTMLButtonElement>("#launch")!; launch.focus();
  act(() => root.render(<><button id="launch">Open</button><DrawerShell title="Agent" onClose={() => {}} footer={<button>Done</button>}>Details</DrawerShell></>));
  const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
  key(panel, "Tab"); expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
  key(document.activeElement!, "Tab"); // Browser normally moves to Done; simulate boundary directly.
  const done = [...panel.querySelectorAll<HTMLButtonElement>("button")].at(-1)!; done.focus();
  key(done, "Tab"); expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
  act(() => root.render(<button id="launch">Open</button>)); expect(document.activeElement).toBe(launch);
});


it("Escape dismisses only the picker inside a drawer, then the drawer", () => {
  const close = vi.fn();
  const host = mount(<DrawerShell title="Nested" onClose={close}><SingleSelect value={null} onChange={() => {}} placeholder="Choose" options={[{ value: "a", label: "Alpha" }]} /></DrawerShell>);
  const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
  act(() => trigger.click());
  act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(close).toHaveBeenCalledOnce();
});


it("keeps page scrolling locked until the last dialog unmounts", () => {
  document.body.style.overflow = "auto";
  mount(<><DrawerShell title="Outer" onClose={() => {}} /><DrawerShell title="Inner" onClose={() => {}} /></>);
  expect(document.body.style.overflow).toBe("hidden");
  act(() => root.render(<DrawerShell title="Outer" onClose={() => {}} />));
  expect(document.body.style.overflow).toBe("hidden");
  act(() => root.render(null));
  expect(document.body.style.overflow).toBe("auto");
  document.body.style.overflow = "";
});

it("renders the accent alert with a custom icon as a polite status", () => {
  const host = mount(<Alert tone="accent" icon={<svg data-testid="inbox" />} actions={<button type="button">Review</button>}>2 requests</Alert>);
  const alert = host.querySelector("[role=status]")!;
  expect(alert.className).toContain("bg-accent-soft");
  expect(alert.querySelector("[data-testid=inbox]")).not.toBeNull();
  expect(alert.textContent).toContain("2 requests");
});
