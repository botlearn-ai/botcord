import { describe, expect, it } from "vitest";
import { textHasMention } from "./MessageComposer";

describe("textHasMention", () => {
  it("keeps structured @Name(agentId) mentions active", () => {
    expect(textHasMention("@Harry(ag_973dfb9193eb) 今天的AI日报发一下呢", "Harry")).toBe(true);
  });

  it("does not match a display name prefix inside a longer name", () => {
    expect(textHasMention("@HarryPotter please reply", "Harry")).toBe(false);
  });
});
