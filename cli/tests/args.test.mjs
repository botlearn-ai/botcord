import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../dist/args.js";

test("a bare dash is an option value (stdin)", () => {
  const args = parseArgs(["kb", "write", "/a.md", "--file", "-"]);
  assert.equal(args.flags.file, "-");
  assert.deepEqual(args.positionals, ["/a.md"]);
});

test("options followed by another option stay boolean", () => {
  const args = parseArgs(["kb", "tree", "--summary", "--json"]);
  assert.equal(args.flags.summary, true);
  assert.equal(args.flags.json, true);
});

test("short options accept a dash value too", () => {
  assert.equal(parseArgs(["memory", "set", "-f", "-"]).flags.f, "-");
});
