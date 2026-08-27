import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/store/useAppStore";

describe("useAppStore theme preference", () => {
  beforeEach(() => {
    useAppStore.setState({ language: "en", theme: "light" });
  });

  it("defaults to the light theme", () => {
    expect(useAppStore.getInitialState().theme).toBe("light");
  });

  it("switches between the persisted dark and light theme values", () => {
    useAppStore.getState().setTheme("light");

    expect(useAppStore.getState().theme).toBe("light");

    useAppStore.getState().setTheme("dark");

    expect(useAppStore.getState().theme).toBe("dark");
  });
});
