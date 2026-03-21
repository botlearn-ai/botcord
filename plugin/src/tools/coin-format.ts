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
