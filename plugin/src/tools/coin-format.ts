export function formatCoinAmount(minorValue: string | number | null | undefined): string {
  const minor = typeof minorValue === "number"
    ? minorValue
    : Number.parseInt(minorValue ?? "0", 10);

  if (!Number.isFinite(minor)) return "0.00 COIN";

  return `${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} COIN`;
}

/**
 * Convert a COIN-denominated string (e.g. "10", "9.50") to a minor-unit
 * string suitable for the Hub API (1 COIN = 100 minor units).
 * Accepts non-negative numbers with up to 2 decimal places.
 * Returns null if the input is missing, malformed, negative, or has 3+ decimals.
 */
const COIN_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

export function parseCoinToMinor(coinValue: string | undefined | null): string | null {
  if (coinValue == null || coinValue === "") return null;
  const trimmed = coinValue.trim();
  if (!COIN_PATTERN.test(trimmed)) return null;
  const dotIndex = trimmed.indexOf(".");
  if (dotIndex === -1) return String(Number.parseInt(trimmed, 10) * 100);
  const intPart = trimmed.slice(0, dotIndex);
  const fracPart = trimmed.slice(dotIndex + 1).padEnd(2, "0");
  return String(Number.parseInt(intPart, 10) * 100 + Number.parseInt(fracPart, 10));
}
