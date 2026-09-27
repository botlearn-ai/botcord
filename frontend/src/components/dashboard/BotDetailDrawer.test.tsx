import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/usePolicyStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/usePolicyStore")>();
  const store = actual.usePolicyStore;
  return { ...actual, usePolicyStore: Object.assign((selector: (s: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) };
});
import { PolicyTab } from "./BotDetailDrawer";
import { usePolicyStore } from "@/store/usePolicyStore";
import { botDetailDrawer } from "@/lib/i18n/translations/dashboard";

const render = () => renderToStaticMarkup(<PolicyTab agentId="ag_1" t={botDetailDrawer.en} />);
beforeEach(() => usePolicyStore.setState({ globalByAgent: {}, globalLoading: {} }));

describe("bot policy tab loading", () => {
  it("shows a placeholder before first policy response", () => {
    usePolicyStore.setState({ globalLoading: { ag_1: true } });
    expect(render()).toContain("animate-pulse");
  });
  it("keeps cached settings visible during background refresh", () => {
    usePolicyStore.setState({
      globalLoading: { ag_1: true },
      globalByAgent: { ag_1: {
        contact_policy: "open", allow_agent_sender: true, allow_human_sender: true,
        room_invite_policy: "open", default_attention: "always", attention_keywords: [],
      } },
    });
    const html = render();
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain('name="contact_policy_ag_1"');
  });
  it("does not show another agent's cached policy", () => {
    usePolicyStore.setState({ globalByAgent: { ag_2: {
      contact_policy: "open", allow_agent_sender: true, allow_human_sender: true,
      room_invite_policy: "open", default_attention: "always", attention_keywords: [],
    } } });
    expect(render()).toContain("animate-pulse");
  });
});
