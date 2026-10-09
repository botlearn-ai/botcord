import { describe, expect, it } from "vitest";
import { isDirectRoomId } from "../direct-room.js";

describe("isDirectRoomId", () => {
  it("treats personal and organization DMs as direct", () => {
    expect(isDirectRoomId("rm_dm_hu_a_ag_b")).toBe(true);
    expect(isDirectRoomId("rm_sdm_4e232f38c2d98e6b31b3")).toBe(true);
  });

  it("treats group rooms, owner-chat and missing ids as not direct", () => {
    expect(isDirectRoomId("rm_86e7c74d4492")).toBe(false);
    expect(isDirectRoomId("rm_oc_owner")).toBe(false);
    expect(isDirectRoomId(undefined)).toBe(false);
    expect(isDirectRoomId("")).toBe(false);
  });
});
