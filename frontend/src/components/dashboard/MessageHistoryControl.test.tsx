import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import MessageHistoryControl from "./MessageHistoryControl";

it("provides an accessible history action with three animated chevrons aligned with the accent label", () => {
  const html = renderToStaticMarkup(<MessageHistoryControl onLoad={() => {}} loadLabel="加载更早消息" scrollLabel="向顶部滚动" />);
  expect(html).toContain('type="button"');
  expect(html).toContain("加载更早消息");
  expect(html).toContain('aria-hidden="true"');
  expect(html.match(/message-history-chevron /g)).toHaveLength(3);
  expect(html).toContain("inline-flex items-center gap-2 text-accent-text");
  expect(html).toContain("message-history-arrows");
  expect(html).toContain("motion-reduce:animate-none");
});
