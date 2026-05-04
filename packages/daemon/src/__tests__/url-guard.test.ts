import { describe, expect, it } from "vitest";
import {
  assertSafeBaseUrl,
  UnsafeBaseUrlError,
} from "../gateway/channels/url-guard.js";
import { mintLoginId } from "../gateway/channels/login-session.js";

describe("assertSafeBaseUrl (W9 allowlist)", () => {
  it("accepts undefined / empty (caller falls back to default)", () => {
    expect(() => assertSafeBaseUrl(undefined)).not.toThrow();
    expect(() => assertSafeBaseUrl(null)).not.toThrow();
    expect(() => assertSafeBaseUrl("")).not.toThrow();
  });

  it("accepts the production iLink and Telegram base URLs", () => {
    expect(() => assertSafeBaseUrl("https://ilinkai.weixin.qq.com")).not.toThrow();
    expect(() => assertSafeBaseUrl("https://api.telegram.org")).not.toThrow();
  });

  it("rejects http://", () => {
    expect(() => assertSafeBaseUrl("http://api.telegram.org")).toThrow(UnsafeBaseUrlError);
  });

  it("rejects loopback hostname (allowlist miss)", () => {
    expect(() => assertSafeBaseUrl("https://localhost")).toThrow(UnsafeBaseUrlError);
    expect(() => assertSafeBaseUrl("https://localhost:9999")).toThrow(UnsafeBaseUrlError);
  });

  it("rejects loopback IPv4", () => {
    expect(() => assertSafeBaseUrl("https://127.0.0.1")).toThrow(UnsafeBaseUrlError);
    expect(() => assertSafeBaseUrl("https://127.1.2.3")).toThrow(UnsafeBaseUrlError);
  });

  it("rejects link-local AWS metadata IP", () => {
    expect(() => assertSafeBaseUrl("https://169.254.169.254")).toThrow(UnsafeBaseUrlError);
  });

  it("rejects RFC1918 private IPv4", () => {
    expect(() => assertSafeBaseUrl("https://10.0.0.5")).toThrow(UnsafeBaseUrlError);
    expect(() => assertSafeBaseUrl("https://192.168.1.1")).toThrow(UnsafeBaseUrlError);
    expect(() => assertSafeBaseUrl("https://172.16.5.5")).toThrow(UnsafeBaseUrlError);
  });

  it("rejects loopback IPv6", () => {
    expect(() => assertSafeBaseUrl("https://[::1]")).toThrow(UnsafeBaseUrlError);
  });

  it("rejects malformed URLs", () => {
    expect(() => assertSafeBaseUrl("not-a-url")).toThrow(UnsafeBaseUrlError);
  });

  it("W9: rejects GCP metadata hostnames not in allowlist", () => {
    expect(() => assertSafeBaseUrl("https://metadata.google.internal")).toThrow(UnsafeBaseUrlError);
    expect(() => assertSafeBaseUrl("https://metadata")).toThrow(UnsafeBaseUrlError);
  });

  it("W9: rejects *.internal and *.svc.cluster.local hostnames", () => {
    expect(() => assertSafeBaseUrl("https://evil.internal")).toThrow(UnsafeBaseUrlError);
    expect(() => assertSafeBaseUrl("https://my-service.svc.cluster.local")).toThrow(UnsafeBaseUrlError);
  });

  it("W9: rejects any arbitrary hostname not in allowlist", () => {
    expect(() => assertSafeBaseUrl("https://attacker.com")).toThrow(UnsafeBaseUrlError);
    expect(() => assertSafeBaseUrl("https://evil.api.telegram.org")).toThrow(UnsafeBaseUrlError);
  });
});

describe("W5: mintLoginId uses 128-bit entropy", () => {
  it("generates a wechat loginId with 32 hex chars in the random segment", () => {
    const id = mintLoginId("wechat");
    expect(id).toMatch(/^wxl_/);
    const rand = id.split("_")[2]!;
    // randomBytes(16).toString("hex") = 32 hex chars
    expect(rand).toHaveLength(32);
    expect(rand).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates a telegram loginId with 32 hex chars in the random segment", () => {
    const id = mintLoginId("telegram");
    expect(id).toMatch(/^tgl_/);
    const rand = id.split("_")[2]!;
    expect(rand).toHaveLength(32);
    expect(rand).toMatch(/^[0-9a-f]{32}$/);
  });
});
