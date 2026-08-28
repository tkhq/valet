import type { SecurityCostWire } from "@valet/api/wire";
import { formatTokens, formatUsd } from "~/lib/format-usage";

/**
 * The engagement's spend, compact (spec §engagement cost). Tokens always show;
 * the dollar amount shows only when `priced` is true. An unpriced provider
 * (`priced: false`) shows a muted "cost n/a" instead of a wrong dollar amount.
 * Zero spend renders nothing — the caller decides the fallback.
 */
export function CostChip({ cost, className }: { cost: SecurityCostWire; className?: string }) {
  if (cost.totalTokens <= 0 && cost.costUsd <= 0) return null;
  return (
    <span className={className} data-testid="engagement-cost">
      <span className="tabular-nums">{formatTokens(cost.totalTokens)}</span> tokens
      {cost.priced ? (
        <>
          {" · ~"}
          <span className="tabular-nums">{formatUsd(cost.costUsd)}</span>
        </>
      ) : (
        <span className="text-muted"> · cost n/a</span>
      )}
    </span>
  );
}

/** The manifest card's final cost line, e.g. "Review cost: 1.2M tokens · ~$0.42".
 * Renders nothing when the engagement spent nothing. */
export function ReviewCostLine({ cost }: { cost: SecurityCostWire }) {
  if (cost.totalTokens <= 0 && cost.costUsd <= 0) return null;
  return (
    <div className="mt-1.5 text-[11px] text-muted" data-testid="review-cost">
      Review cost: <span className="tabular-nums">{formatTokens(cost.totalTokens)}</span> tokens
      {cost.priced ? (
        <>
          {" · ~"}
          <span className="tabular-nums">{formatUsd(cost.costUsd)}</span>
        </>
      ) : (
        " · cost n/a"
      )}
    </div>
  );
}
