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

/** List price per million tokens for a model picker: "$0.62 in / $1.85 out
 * per 1M tokens", or "$0.62 / $1.85" in `short` form for a chip. Rates below
 * a cent keep a third decimal so cheap models do not read as free; a missing
 * or all-zero price returns undefined so callers render nothing. */
export function formatPerMillion(
  pricing: { input: number; output: number } | undefined,
  form: "long" | "short" = "long",
): string | undefined {
  if (!pricing) return undefined;
  const { input, output } = pricing;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  if (input <= 0 && output <= 0) return undefined;
  const rate = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
  return form === "short"
    ? `${rate(input)} / ${rate(output)}`
    : `${rate(input)} in / ${rate(output)} out per 1M tokens`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
