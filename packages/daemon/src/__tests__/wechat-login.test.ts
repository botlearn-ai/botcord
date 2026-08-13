import { afterEach, describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../gateway/channels/wechat-http.js";
import {
  DEFAULT_WECHAT_LOGIN_TIMEOUT_MS,
  getBotQrcode,
  getQrcodeStatus,
} from "../gateway/channels/wechat-login.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function installAbortableHangingFetch(): FetchLike {
  return vi.fn((_url, init) => {
    const signal = init?.signal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  }) as FetchLike;
}

function mockTimeoutSignal(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
    return controller.signal;
  });
}

describe("WeChat login request timeouts", () => {
  it("aborts a hanging get_bot_qrcode fetch after the default 10s budget", async () => {
    const timeout = mockTimeoutSignal();
    const fetchImpl = installAbortableHangingFetch();

    await expect(getBotQrcode({ fetchImpl })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledWith(DEFAULT_WECHAT_LOGIN_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("aborts a hanging get_qrcode_status fetch after a configured budget", async () => {
    const timeout = mockTimeoutSignal();
    const fetchImpl = installAbortableHangingFetch();

    await expect(getQrcodeStatus("QR", { fetchImpl, timeoutMs: 25 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(timeout).toHaveBeenCalledWith(25);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
