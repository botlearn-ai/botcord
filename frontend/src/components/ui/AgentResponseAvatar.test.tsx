import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import AgentResponseAvatar from "./AgentResponseAvatar";
it("distinguishes ignored, unknown and no-reply without visible text", () => {
  const render = (state: "ignored" | "unknown" | "no_reply") => renderToStaticMarkup(<AgentResponseAvatar id="a" name="A" state={state} />);
  expect(render("ignored")).toContain("outline-dashed");
  expect(render("unknown")).not.toContain("outline-dashed");
  expect(render("unknown")).not.toContain("<svg");
  expect(render("no_reply")).toContain("lucide-minus");
});
it("keeps semantic status when animation is disabled", () => {
  const html = renderToStaticMarkup(<AgentResponseAvatar id="a" name="A" state="replying" />);
  expect(html).toContain('data-status="replying"');
  expect(html).toContain("animation:none");
});
