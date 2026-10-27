// @vitest-environment jsdom
// Run explicitly: BOTCORD_CACHE_BENCHMARK=1 pnpm vitest run src/components/dashboard/conversation-cache.benchmark.test.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
const endpoint = vi.hoisted(() => ({ base: "" }));
vi.mock("nextjs-toploader/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/chats/messages" }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, syncConversations: async (cursor: string | null) =>
    (await fetch(endpoint.base, { method: "POST", body: JSON.stringify({ cursor }) })).json() } };
});
import MessagesPanel from "./sidebar/MessagesPanel";
import DashboardShellSkeleton from "./DashboardShellSkeleton";
import { useConversationDirectoryStore as directory } from "@/store/useConversationDirectoryStore";
import { useDashboardSessionStore as session } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore as ui } from "@/store/useDashboardUIStore";
import type { DashboardRoom } from "@/lib/types";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const room = (i: number): DashboardRoom => ({ room_id: `rm_mock_${i}`, name: `Saved room ${i}`, description: "", owner_id: "hu_fixture", visibility: "private", member_count: 3, my_role: "member", rule: null, has_unread: false, last_message_at: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(), last_message_preview: "Saved message", last_sender_name: "Fixture", revision: "v1" });

it.skipIf(process.env.BOTCORD_CACHE_BENCHMARK !== "1")("measures cached shell and delta DOM rendering across a real slow local HTTP connection", async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  const rooms = Array.from({ length: 100 }, (_, i) => room(i));
  const batches: number[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const { cursor } = JSON.parse(body);
    const upserts = cursor === null ? rooms : rooms.filter((r) => r.revision === "v2");
    batches.push(upserts.length);
    setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ next_cursor: cursor === null ? "initial" : "updated", reset: cursor === null, account_id: "fixture", human_id: "hu_fixture", upserts, removed_ids: [], has_more: false })); }, 1500);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    localStorage.clear(); directory.getState().activate("fixture");
    session.setState({ ...session.getInitialState(), sessionMode: "authed-no-agent", token: "fixture", activeIdentity: { type: "human", id: "hu_fixture" } });
    ui.setState({ ...ui.getInitialState(), sidebarTab: "messages", messagesFilter: "self-all" });
    const panel = <MessagesPanel isGuest={false} onCreateRoom={() => {}} onAddFriend={() => {}} />;
    const started = performance.now();
    flushSync(() => root.render(panel));
    await directory.getState().sync();
    while (!host.textContent?.includes("Saved room 0")) await delay(5);
    const coldDomMs = Math.round(performance.now() - started);
    flushSync(() => root.render(null)); directory.getState().activate(null);
    rooms[99] = { ...rooms[99], name: "Newest room", revision: "v2", last_message_at: "2026-02-01T00:00:00Z" };
    const reentry = performance.now(); directory.getState().activate("fixture");
    const pending = directory.getState().sync();
    flushSync(() => root.render(<DashboardShellSkeleton variant="messages" />));
    expect(host.textContent).toContain("Saved room 0");
    expect(host.querySelector("[inert]")).not.toBeNull();
    const cachedShellDomMs = Math.round(performance.now() - reentry);
    flushSync(() => root.render(panel));
    expect(host.textContent).toContain("Saved room 0");
    await pending;
    while (!host.textContent?.includes("Newest room")) await delay(5);
    const deltaDomMs = Math.round(performance.now() - reentry);
    expect(host.textContent!.indexOf("Newest room")).toBeLessThan(host.textContent!.indexOf("Saved room 0"));
    expect(batches).toEqual([100, 1]);
    expect(cachedShellDomMs).toBeLessThan(1500);
    const result = { runtime: "React DOM + jsdom, real localhost HTTP; excludes browser paint and Supabase session restore", rooms: 100, delayMs: 1500, coldDomMs, cachedShellDomMs, deltaDomMs, responseRoomCounts: batches };
    writeFileSync("docs/conversation-cache-results.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally {
    flushSync(() => root.unmount()); host.remove(); directory.getState().activate(null, true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
