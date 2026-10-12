// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Button from "./Button";
import LinkButton from "./LinkButton";
import Checkbox from "./Checkbox";
import DialogSurface from "./DialogSurface";
import { Textarea } from "./Input";
import Alert from "./Alert";
import DismissLayer from "./DismissLayer";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
function mount(content: React.ReactNode) { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(content)); return host; }
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
it("row actions remain native buttons with safe form defaults and selection semantics", () => {
  const action = vi.fn(), submit = vi.fn();
  const host = mount(<form onSubmit={submit}><Button variant="row" aria-pressed onClick={action}>Long row content</Button></form>);
  act(() => host.querySelector("button")!.click());
  expect(action).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled(); expect(host.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
});
it("link actions preserve href, target and anchor refs", () => {
  const ref = createRef<HTMLAnchorElement>();
  const host = mount(<LinkButton ref={ref} href="https://example.com/docs" target="_blank" rel="noopener noreferrer">Docs</LinkButton>);
  expect(ref.current).toBe(host.querySelector("a")); expect(ref.current?.getAttribute("href")).toBe("https://example.com/docs"); expect(ref.current?.target).toBe("_blank");
});
it("composed checkbox labels activate the native input without nesting labels", () => {
  const change = vi.fn(); const host = mount(<label>Choose<Checkbox checked={false} onCheckedChange={change} wrapLabel={false} /></label>);
  expect(host.querySelectorAll("label")).toHaveLength(1);
  act(() => host.querySelector("label")!.click()); expect(change).toHaveBeenCalledWith(true);
});
it("message textarea retains composition events, value and ref", () => {
  const ref = createRef<HTMLTextAreaElement>(), compose = vi.fn();
  mount(<Textarea ref={ref} variant="message" defaultValue="草稿" onCompositionStart={compose} />);
  act(() => ref.current!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "你" })));
  expect(compose).toHaveBeenCalledOnce(); expect(ref.current?.value).toBe("草稿");
});
it("surface blocks busy dismissal and only the top modal consumes Escape", () => {
  const outer = vi.fn(), inner = vi.fn();
  const host = mount(<><DialogSurface title="Outer" onClose={outer}>Outer body</DialogSurface><DialogSurface title="Inner" onClose={inner} busy>Inner body</DialogSurface></>);
  const escape = () => act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  escape(); expect(inner).not.toHaveBeenCalled(); expect(outer).not.toHaveBeenCalled();
  act(() => root.render(<><DialogSurface title="Outer" onClose={outer}>Outer body</DialogSurface><DialogSurface title="Inner" onClose={inner}>Inner body</DialogSurface></>));
  escape(); expect(inner).toHaveBeenCalledOnce(); expect(outer).not.toHaveBeenCalled(); expect(host.querySelectorAll('[aria-modal="true"]')).toHaveLength(2);
});
it("nonmodal inspectors preserve focus and page scrolling while accepting Escape", () => {
  const close = vi.fn(); const launcher = document.createElement("button"); document.body.append(launcher); launcher.focus(); const overflow = document.body.style.overflow;
  const host = mount(<DialogSurface title="Inspector" onClose={close} modal={false}>Details</DialogSurface>);
  expect(document.activeElement).toBe(launcher); expect(document.body.style.overflow).toBe(overflow); expect(host.querySelector('[aria-modal="true"]')).toBeNull();
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }))); expect(close).toHaveBeenCalledOnce();
});
it("alerts expose their element ref for existing business animations", () => {
  const ref = createRef<HTMLDivElement>(); const host = mount(<Alert ref={ref} tone="danger">Failed</Alert>); expect(ref.current).toBe(host.querySelector('[role="alert"]'));
});

it("dismiss layers forward the animation ref and close without submitting forms", () => {
  const ref = createRef<HTMLButtonElement>(), close = vi.fn(), submit = vi.fn();
  mount(<form onSubmit={submit}><DismissLayer ref={ref} label="Close navigation" onClick={close} /></form>);
  act(() => ref.current!.click()); expect(close).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled(); expect(ref.current?.tabIndex).toBe(-1);
});

it("routes Escape to visual topmost confirmation even when a later portal has a large local z-index", () => {
  const high = vi.fn(), low = vi.fn();
  mount(<><div style={{ position: "fixed", zIndex: 1100 }}><DialogSurface title="Confirm" onClose={high}>Confirm</DialogSurface></div><div style={{ position: "fixed", zIndex: 1000 }}><div style={{ position: "absolute", zIndex: 2000000 }}><DialogSurface title="Drawer" onClose={low}>Drawer</DialogSurface></div></div></>);
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  expect(high).toHaveBeenCalledOnce(); expect(low).not.toHaveBeenCalled();
});
