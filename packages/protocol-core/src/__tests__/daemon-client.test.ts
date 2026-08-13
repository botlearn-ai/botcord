import { describe, expect, it } from "vitest";
import {
  HUB_CONTROL_PUBLIC_KEY,
  resolveHubControlPublicKey,
  resolveHubControlPublicKeys,
} from "../daemon-client.js";

describe("Hub control public key resolution", () => {
  it("preserves the legacy single-key override", () => {
    expect(resolveHubControlPublicKeys({ BOTCORD_HUB_CONTROL_PUBLIC_KEY: " legacy " }))
      .toEqual(["legacy"]);
    expect(resolveHubControlPublicKey({ BOTCORD_HUB_CONTROL_PUBLIC_KEY: "legacy" }))
      .toBe("legacy");
  });

  it("parses and deduplicates a multi-key rotation ring", () => {
    expect(resolveHubControlPublicKeys({
      BOTCORD_HUB_CONTROL_PUBLIC_KEYS: "old-key, new-key\nold-key",
    })).toEqual(["old-key", "new-key"]);
  });

  it("gives the explicit multi-key ring precedence over the legacy variable", () => {
    expect(resolveHubControlPublicKeys({
      BOTCORD_HUB_CONTROL_PUBLIC_KEYS: "old-key,new-key",
      BOTCORD_HUB_CONTROL_PUBLIC_KEY: "legacy-key",
    })).toEqual(["old-key", "new-key"]);
  });

  it("falls back to the embedded key when env configuration is empty", () => {
    expect(resolveHubControlPublicKeys({
      BOTCORD_HUB_CONTROL_PUBLIC_KEYS: " , \n ",
      BOTCORD_HUB_CONTROL_PUBLIC_KEY: "",
    })).toEqual([HUB_CONTROL_PUBLIC_KEY]);
  });
});
