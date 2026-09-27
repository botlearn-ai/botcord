import { beforeEach, expect, it, vi } from "vitest";
import { api, userApi } from "@/lib/api";
import { loadInviteLanding, loadSharedPreview } from "./landing-requests";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { getInvite: vi.fn(), getSharedRoom: vi.fn() },
  userApi: { getMe: vi.fn() },
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth }) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const handlers = () => ({ preview: vi.fn(), error: vi.fn(), auth: vi.fn() });
const invite = { code: "invite" } as Awaited<ReturnType<typeof api.getInvite>>;
beforeEach(() => vi.resetAllMocks());

it("shows an invitation before the session lookup completes", async () => {
  const session = deferred<unknown>();
  auth.getSession.mockReturnValue(session.promise);
  vi.mocked(api.getInvite).mockResolvedValue(invite);
  const output = handlers();
  loadInviteLanding("invite", output);
  await vi.waitFor(() => expect(output.preview).toHaveBeenCalledWith(invite));
  expect(output.auth).not.toHaveBeenCalled();
  expect(userApi.getMe).not.toHaveBeenCalled();
  session.resolve({ data: { session: null } });
  await vi.waitFor(() => expect(output.auth).toHaveBeenCalledWith("guest"));
});

it("shows the preview before the signed-in profile resolves", async () => {
  auth.getSession.mockResolvedValue({ data: { session: { access_token: "test" } } });
  const profile = deferred<Awaited<ReturnType<typeof userApi.getMe>>>();
  vi.mocked(userApi.getMe).mockReturnValue(profile.promise);
  vi.mocked(api.getInvite).mockResolvedValue(invite);
  const output = handlers();
  loadInviteLanding("invite", output);
  await vi.waitFor(() => expect(output.preview).toHaveBeenCalledOnce());
  expect(output.auth).not.toHaveBeenCalled();
  profile.resolve({ agents: [{}] } as unknown as Awaited<ReturnType<typeof userApi.getMe>>);
  await vi.waitFor(() => expect(output.auth).toHaveBeenCalledWith("authed-ready"));
});

it("keeps auth service failures separate from public preview errors", async () => {
  auth.getSession.mockRejectedValue(new Error("auth unavailable"));
  vi.mocked(api.getInvite).mockResolvedValue(invite);
  const output = handlers();
  loadInviteLanding("invite", output);
  await vi.waitFor(() => expect(output.auth).toHaveBeenCalledWith("guest"));
  expect(output.preview).toHaveBeenCalledOnce();
  expect(output.error).not.toHaveBeenCalled();
});

it("ignores old invitation and session results after navigation", async () => {
  const preview = deferred<Awaited<ReturnType<typeof api.getInvite>>>();
  const session = deferred<unknown>();
  vi.mocked(api.getInvite).mockReturnValue(preview.promise);
  auth.getSession.mockReturnValue(session.promise);
  const output = handlers();
  const cancel = loadInviteLanding("old", output);
  cancel();
  preview.resolve(invite);
  session.resolve({ data: { session: { access_token: "test" } } });
  await Promise.all([preview.promise, session.promise]);
  expect(output.preview).not.toHaveBeenCalled();
  expect(output.auth).not.toHaveBeenCalled();
  expect(userApi.getMe).not.toHaveBeenCalled();
});

it("ignores old share responses after the next share has loaded", async () => {
  const old = deferred<Awaited<ReturnType<typeof api.getSharedRoom>>>();
  const current = { share_id: "new" } as unknown as Awaited<ReturnType<typeof api.getSharedRoom>>;
  vi.mocked(api.getSharedRoom).mockReturnValueOnce(old.promise).mockResolvedValueOnce(current);
  const output = handlers();
  const cancel = loadSharedPreview("old", output);
  cancel();
  loadSharedPreview("new", output);
  await vi.waitFor(() => expect(output.preview).toHaveBeenCalledWith(current));
  old.resolve({ ...current, room: { name: "stale" } } as typeof current);
  await old.promise;
  expect(output.preview).toHaveBeenCalledOnce();
});

it("ignores stale share errors but reports current failures", async () => {
  const old = deferred<Awaited<ReturnType<typeof api.getSharedRoom>>>();
  vi.mocked(api.getSharedRoom).mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error("expired"));
  const output = handlers();
  const cancel = loadSharedPreview("old", output);
  cancel();
  loadSharedPreview("new", output);
  old.reject(new Error("old failure"));
  await vi.waitFor(() => expect(output.error).toHaveBeenCalledOnce());
  expect(output.error).toHaveBeenCalledWith(new Error("expired"));
});
