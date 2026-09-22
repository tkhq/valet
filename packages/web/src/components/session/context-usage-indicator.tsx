import type { WireThreadContextState } from "@valet/api/wire";
import { Tooltip } from "~/components/primitives";
import { formatTokens } from "~/lib/format-usage";

/** Live thread context occupancy. This never reads cumulative usage data. */
export function ContextUsageIndicator({
  context,
}: {
  context: WireThreadContextState | undefined;
}) {
  if (!context) {
    return <span className="text-[11px] text-muted">Estimated context: calculating…</span>;
  }

  const detail = `Estimated ${formatTokens(context.estimatedTokens)} tokens in use on ${context.model}. This is live context occupancy, not billed usage.`;
  if (context.contextWindow === null) {
    return (
      <Tooltip content={`${detail} This model has an unknown context-window limit.`}>
        <span className="text-[11px] text-muted" data-testid="context-usage">
          Estimated context: unknown limit
        </span>
      </Tooltip>
    );
  }

  const percent = Math.min(
    100,
    Math.max(0, Math.round((context.estimatedTokens / context.contextWindow) * 100)),
  );
  return (
    <Tooltip
      content={`${detail} Limit: ${formatTokens(context.contextWindow)} tokens. ${Math.max(0, 100 - percent)}% remains.`}
    >
      <span className="text-[11px] tabular-nums text-muted" data-testid="context-usage">
        Estimated context: {percent}%
      </span>
    </Tooltip>
  );
}
