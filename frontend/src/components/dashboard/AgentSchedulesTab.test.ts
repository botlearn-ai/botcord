import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ userApi: { listAgentScheduleRuns: vi.fn() } }));
import { userApi } from "@/lib/api";
import { loadScheduleRunSummaries } from "./AgentSchedulesTab";

const rows = Array.from({ length: 6 }, (_, index) => ({ id: String(index) })) as Parameters<typeof loadScheduleRunSummaries>[1];
function deferred() {
  let resolve!: (value: { runs: never[] }) => void;
  return { promise: new Promise<{ runs: never[] }>((done) => { resolve = done; }), resolve: () => resolve({ runs: [] }) };
}

describe("schedule history loading", () => {
  it("shows fast summaries before a slow request completes and caps concurrency at three", async () => {
    const pending = rows.map(() => deferred());
    const api = vi.mocked(userApi.listAgentScheduleRuns).mockImplementation((_agent, id) => pending[Number(id)].promise);
    const onRuns = vi.fn();
    const loading = loadScheduleRunSummaries("ag_1", rows, onRuns, () => true);
    expect(api).toHaveBeenCalledTimes(3);
    pending[1].resolve();
    await vi.waitFor(() => expect(onRuns).toHaveBeenCalledWith("1", []));
    expect(onRuns).not.toHaveBeenCalledWith("0", []);
    expect(api).toHaveBeenCalledTimes(4);
    pending.forEach((request) => request.resolve());
    await loading;
    expect(onRuns).toHaveBeenCalledTimes(6);
  });
  it("does not apply or start more history requests after switching agents", async () => {
    const pending = deferred();
    const api = vi.mocked(userApi.listAgentScheduleRuns).mockReset().mockReturnValue(pending.promise);
    let current = true;
    const onRuns = vi.fn();
    const loading = loadScheduleRunSummaries("ag_1", rows, onRuns, () => current);
    current = false;
    pending.resolve();
    await loading;
    expect(onRuns).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(3);
  });
});
