import { describe, expect, it } from "vitest";
import { isImeComposing, textHasMention } from "./MessageComposer";

describe("textHasMention", () => {
  it("keeps structured @Name(agentId) mentions active", () => {
    expect(textHasMention("@Harry(ag_973dfb9193eb) 今天的AI日报发一下呢", "Harry")).toBe(true);
  });

  it("does not match a display name prefix inside a longer name", () => {
    expect(textHasMention("@HarryPotter please reply", "Harry")).toBe(false);
  });
});

describe("isImeComposing", () => {
  it("treats explicit composition state as active", () => {
    expect(isImeComposing({ isComposing: false }, true)).toBe(true);
  });

  it("honors the browser composition flag", () => {
    expect(isImeComposing({ isComposing: true }, false)).toBe(true);
  });

  it("handles IME process key events reported with keyCode 229", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 }, false)).toBe(true);
  });

  it("returns false for regular key events outside composition", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 }, false)).toBe(false);
  });
});
