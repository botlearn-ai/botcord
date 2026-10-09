import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import AccessBadge from "./AccessBadge";
import { accessBadge, capabilityBadge } from "@/lib/team-access";

it("shows the label and keeps the plain-language explanation available", () => {
  const html = renderToStaticMarkup(<AccessBadge info={accessBadge("consultant", true)} />);
  expect(html).toContain("只读");
  expect(html).toContain('title="只能回答问题和读文件。"');
  expect(html).toContain("sr-only");
});

it("marks full capability with the danger tone", () => {
  const html = renderToStaticMarkup(<AccessBadge info={capabilityBadge("full", false)} />);
  expect(html).toContain("Full");
  expect(html).toContain("text-red-500");
  expect(html).toContain("run any command on the owner&#x27;s computer");
});
