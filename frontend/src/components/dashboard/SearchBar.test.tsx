// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import SearchBar from "./SearchBar";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.useRealTimers());
it("keeps immediate input feedback, debounces search and cancels pending work on unmount", () => {
  vi.useFakeTimers(); const search = vi.fn(), input = vi.fn();
  const host = document.createElement("div"); const root = createRoot(host);
  act(() => root.render(<SearchBar onSearch={search} onInputChange={input} placeholder="Search agents" />));
  const field = host.querySelector("input")!;
  const type = (value: string) => act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
  type("a"); type("atlas"); expect(input).toHaveBeenLastCalledWith("atlas"); expect(search).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(300)); expect(search).toHaveBeenCalledExactlyOnceWith("atlas");
  type("coder"); act(() => root.unmount()); act(() => vi.advanceTimersByTime(300)); expect(search).toHaveBeenCalledTimes(1);
});
