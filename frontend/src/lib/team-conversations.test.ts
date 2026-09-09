import { beforeEach, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import {
  conversationName,
  teamConversationsApi,
  type TeamConversation,
} from "./team-conversations";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  apiFetch: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async () => new Response(JSON.stringify({})));
});
it("uses explicit space paths, user auth, and no-store for organization messages", async () => {
  await teamConversationsApi.messages("org/a", "room/b", { after: 12 });
  expect(apiFetch).toHaveBeenCalledWith(
    "/api/spaces/org%2Fa/conversations/room%2Fb/messages?after=12",
    expect.objectContaining({ cache: "no-store" }),
    null
  );
  await teamConversationsApi.send("a", "b", "hello", "retry-id");
  expect(apiFetch).toHaveBeenLastCalledWith(
    "/api/spaces/a/conversations/b/messages",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ content: "hello", client_id: "retry-id" }),
    }),
    null
  );
});
it("names a DM for the other participant without borrowing a personal identity", () => {
  const dm = {
    kind: "dm",
    participants: [
      { user_id: "me", display_name: "Me" },
      { user_id: "alice", display_name: "Alice" },
    ],
  } as TeamConversation;
  expect(conversationName(dm, "me", "Left")).toBe("Alice");
  expect(conversationName({ ...dm, participants: [] }, "me", "Left")).toBe(
    "Left"
  );
});
