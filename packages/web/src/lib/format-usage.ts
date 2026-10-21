/** Compact formatters for the dashboard usage card. Pure + tested. */

/** 1234 → "1.2k", 5_600_000 → "5.6M", below 1000 verbatim. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimZero((n / 1_000).toFixed(1))}k`;
  if (n < 1_000_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`;
  return `${trimZero((n / 1_000_000_000).toFixed(1))}B`;
}

/** A turn count with its noun: "1 turn", "1,204 turns". */
export function formatTurns(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "turn" : "turns"}`;
}

/** Dollar display tuned for LLM spend: sub-cent shows "<$0.01", under $10
 * keeps cents, larger amounts round to whole dollars. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1_000) return `$${Math.round(n)}`;
  return `$${trimZero((n / 1_000).toFixed(1))}k`;
}

/** Dollar display for the Usage page and workflow step costs: four
 * decimals below a dollar, so a small step's cost never reads as zero, and
 * cents from a dollar up, so a total reads as money ($184.20). */
export function formatUsdPrecise(n: number): string {
  if (n > 0 && n < 0.00005) return "<$0.0001";
  return `$${n.toFixed(Math.abs(n) >= 1 ? 2 : 4)}`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
