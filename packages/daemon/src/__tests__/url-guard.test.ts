import { describe, expect, it } from "vitest";
import {
  assertSafeBaseUrl,
  UnsafeBaseUrlError,
} from "../gateway/channels/url-guard.js";

describe("assertSafeBaseUrl (W1)", () => {
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

  it("rejects loopback hostname", () => {
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
});
