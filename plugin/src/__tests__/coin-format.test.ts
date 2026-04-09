import { describe, expect, it } from "vitest";
import { parseCoinToMinor, formatCoinAmount } from "../tools/coin-format.js";

describe("parseCoinToMinor", () => {
  it("converts whole COIN to minor units", () => {
    expect(parseCoinToMinor("10")).toBe("1000");
    expect(parseCoinToMinor("0")).toBe("0");
    expect(parseCoinToMinor("1")).toBe("100");
  });

  it("converts 1-decimal COIN to minor units", () => {
    expect(parseCoinToMinor("9.5")).toBe("950");
    expect(parseCoinToMinor("0.1")).toBe("10");
  });

  it("converts 2-decimal COIN to minor units", () => {
    expect(parseCoinToMinor("9.50")).toBe("950");
    expect(parseCoinToMinor("0.01")).toBe("1");
    expect(parseCoinToMinor("99.99")).toBe("9999");
  });

  it("rejects 3+ decimal places", () => {
    expect(parseCoinToMinor("1.234")).toBeNull();
    expect(parseCoinToMinor("0.005")).toBeNull();
    expect(parseCoinToMinor("10.999")).toBeNull();
  });

  it("rejects negative values", () => {
    expect(parseCoinToMinor("-1")).toBeNull();
    expect(parseCoinToMinor("-0.50")).toBeNull();
  });

  it("rejects non-numeric strings", () => {
    expect(parseCoinToMinor("abc")).toBeNull();
    expect(parseCoinToMinor("1abc")).toBeNull();
    expect(parseCoinToMinor("1.2.3")).toBeNull();
    expect(parseCoinToMinor("$10")).toBeNull();
    expect(parseCoinToMinor("10 COIN")).toBeNull();
  });

  it("rejects leading zeros", () => {
    expect(parseCoinToMinor("007")).toBeNull();
    expect(parseCoinToMinor("00.50")).toBeNull();
    expect(parseCoinToMinor("01")).toBeNull();
  });

  it("rejects empty and null", () => {
    expect(parseCoinToMinor("")).toBeNull();
    expect(parseCoinToMinor(null)).toBeNull();
    expect(parseCoinToMinor(undefined)).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseCoinToMinor(" 10 ")).toBe("1000");
    expect(parseCoinToMinor("  9.50  ")).toBe("950");
  });

  it("handles large values", () => {
    expect(parseCoinToMinor("999999")).toBe("99999900");
    expect(parseCoinToMinor("100000.99")).toBe("10000099");
  });
});

describe("formatCoinAmount", () => {
  it("formats minor units to COIN display", () => {
    expect(formatCoinAmount(1000)).toBe("10.00 COIN");
    expect(formatCoinAmount("950")).toBe("9.50 COIN");
    expect(formatCoinAmount("1")).toBe("0.01 COIN");
    expect(formatCoinAmount("0")).toBe("0.00 COIN");
  });

  it("handles null/undefined", () => {
    expect(formatCoinAmount(null)).toBe("0.00 COIN");
    expect(formatCoinAmount(undefined)).toBe("0.00 COIN");
  });
});
