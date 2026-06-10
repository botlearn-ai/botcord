import assert from "node:assert/strict";
import test from "node:test";

import { collectRepeatedArgvFlag } from "../dist/commands/gateway.js";

test("gateway send collects repeatable --file flags", () => {
  assert.deepEqual(
    collectRepeatedArgvFlag("file", [
      "gateway",
      "send",
      "--file",
      "a.png",
      "--text",
      "hello",
      "--file=b.pdf",
    ]),
    ["a.png", "b.pdf"],
  );
});
