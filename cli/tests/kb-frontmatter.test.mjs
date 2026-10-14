import assert from "node:assert/strict";
import test from "node:test";

import { parseFrontmatter, renderFrontmatter } from "../dist/kb-frontmatter.js";

test("frontmatter round-trips through render and parse", () => {
  const text = renderFrontmatter(
    {
      title: "发布流程",
      description: "需要上线时读: backend 或 npm 包",
      summary: "  leading space",
      tags: ["release", "a, b"],
      source: ["topic:tp_1"],
      version: 3,
      empty: "",
    },
    "# Body\n---\nnot a fence\n",
  );
  const { meta, body } = parseFrontmatter(text);
  assert.equal(meta.title, "发布流程");
  assert.equal(meta.description, "需要上线时读: backend 或 npm 包");
  assert.equal(meta.summary, "  leading space");
  assert.deepEqual(meta.tags, ["release", "a, b"]);
  assert.deepEqual(meta.source, ["topic:tp_1"]);
  assert.equal(meta.version, "3");
  assert.equal(meta.empty, undefined);
  assert.equal(body, "# Body\n---\nnot a fence\n");
});

test("frontmatter accepts inline lists, single quotes, and missing fences", () => {
  const { meta, body } = parseFrontmatter("---\ntags: [a, 'b']\ntitle: 'it''s'\n---\n\nhello");
  assert.deepEqual(meta.tags, ["a", "b"]);
  assert.equal(meta.title, "it's");
  assert.equal(body, "hello");
  assert.deepEqual(parseFrontmatter("no fence\n---\n"), { meta: {}, body: "no fence\n---\n" });
});
