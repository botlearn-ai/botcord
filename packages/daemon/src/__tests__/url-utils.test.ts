import { describe, expect, it } from "vitest";
import { appendNextParam } from "../url-utils.js";

describe("appendNextParam", () => {
  it("appends next to a URL with no existing query string", () => {
    const out = appendNextParam(
      "https://app.botcord.chat/activate",
      "/settings/daemons",
    );
    expect(out).toBe("https://app.botcord.chat/activate?next=%2Fsettings%2Fdaemons");
  });

  it("preserves existing query params (e.g. ?code=...)", () => {
    const out = appendNextParam(
      "https://app.botcord.chat/activate?code=ABCD-EFGH",
      "/settings/daemons",
    );
    const u = new URL(out);
    expect(u.searchParams.get("code")).toBe("ABCD-EFGH");
    expect(u.searchParams.get("next")).toBe("/settings/daemons");
  });

  it("overwrites an existing next param rather than duplicating it", () => {
    const out = appendNextParam(
      "https://app.botcord.chat/activate?next=/old",
      "/settings/daemons",
    );
    const u = new URL(out);
    // searchParams.getAll guards against ?next=/old&next=/new style duplicates
    expect(u.searchParams.getAll("next")).toEqual(["/settings/daemons"]);
  });

  it("returns the original string when the URL cannot be parsed", () => {
    const out = appendNextParam("not a url", "/settings/daemons");
    expect(out).toBe("not a url");
  });
});
