import type { SecurityCoverageRollupWire } from "@valet/api/wire";

/**
 * The coverage-honesty section (NOT_ASSESSED ledger, M-P2d, spec §Coverage
 * honesty). Shows "N areas assessed, M not assessed", and — when there are
 * gaps — lists each NOT_ASSESSED area with its reason in a warning tone. A gap
 * is a hole the team should know about ("secrets not scanned because gitleaks
 * is missing"), never a silent skip.
 *
 * Renders nothing when the ledger is empty (no coverage recorded yet), so an
 * engagement that never recorded coverage adds no clutter.
 */
export function CoverageSection({ rollup }: { rollup: SecurityCoverageRollupWire }) {
  const total = rollup.assessed + rollup.notAssessed;
  if (total === 0) return null;
  const hasGaps = rollup.gaps.length > 0;
  return (
    <section className="border-b border-line px-4 py-3" aria-label="Coverage">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-ink">Coverage</span>
        <span className="text-muted tabular-nums">
          {rollup.assessed} assessed · {rollup.notAssessed} not assessed
        </span>
      </div>
      {hasGaps && (
        <ul className="mt-2 space-y-1.5">
          {rollup.gaps.map((gap, i) => (
            <li
              key={`${gap.area}-${i}`}
              className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-ink"
            >
              <span className="font-medium">Not assessed: {gap.area}</span>
              {gap.tool && <span className="text-muted"> [{gap.tool}]</span>}
              {gap.reason && <span className="block text-muted">{gap.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
