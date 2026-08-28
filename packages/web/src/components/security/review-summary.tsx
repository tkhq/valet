import type { SecurityEngagementWire, SecurityPlanCellWire } from "@valet/api/wire";
import { categoryLabel, LiveTestingPanel } from "./config-form";

/**
 * The compact, at-a-glance READ-ONLY review summary on the session page (spec
 * §engagement panel, Deviations). It replaces the dense on-session editor: the
 * config is finalized pre-creation on `/security/new`, so the session page only
 * shows what the review was told. A few tight rows — focus, invariants,
 * categories, the plan as a one-line-per-step list — plus the live-testing
 * scope when present.
 */
export function ReviewSummary({
  engagement,
  planCells,
}: {
  engagement: SecurityEngagementWire;
  planCells: SecurityPlanCellWire[];
}) {
  const focus = engagement.focus?.trim() ?? "";
  const invariants = engagement.invariants ?? [];
  const categories = engagement.categories ?? [];
  const hasScopeOrTools =
    (engagement.authorizedScope?.hosts.length ?? 0) > 0 ||
    (engagement.configTools?.length ?? 0) > 0;
  const hasAny =
    focus !== "" ||
    invariants.length > 0 ||
    categories.length > 0 ||
    planCells.length > 0 ||
    hasScopeOrTools;
  if (!hasAny) return null;

  return (
    <div className="border-b border-line px-4 py-3" data-testid="review-summary">
      {focus !== "" && (
        <div className="flex items-baseline gap-2" data-testid="review-summary-focus">
          <span className="shrink-0 text-[11px] font-medium text-muted">Focus</span>
          <span className="min-w-0 truncate text-[11px] text-ink" title={focus}>
            {focus}
          </span>
        </div>
      )}

      {invariants.length > 0 && (
        <div className="mt-1 flex items-baseline gap-2" data-testid="review-summary-invariants">
          <span className="shrink-0 text-[11px] font-medium text-muted">Invariants</span>
          <span
            className="min-w-0 truncate text-[11px] text-ink"
            title={invariants.join("\n")}
          >
            {invariants.length} asserted · {invariants.join(" · ")}
          </span>
        </div>
      )}

      {categories.length > 0 && (
        <div className="mt-1 flex flex-wrap items-baseline gap-1" data-testid="review-summary-categories">
          <span className="mr-1 text-[11px] font-medium text-muted">Categories</span>
          {categories.map((id) => (
            <span
              key={id}
              className="rounded bg-ink-wash px-1.5 py-0.5 text-[10px] text-ink"
            >
              {categoryLabel(id)}
            </span>
          ))}
        </div>
      )}

      {planCells.length > 0 && (
        <div className="mt-2" data-testid="review-summary-plan">
          <span className="text-[11px] font-medium text-muted">Plan</span>
          <ol className="mt-1 flex flex-col gap-0.5">
            {planCells.map((cell) => (
              <li
                key={cell.ordinal}
                className="truncate text-[11px] text-muted"
                title={cell.goal}
              >
                <span className="text-ink">{cell.ordinal}</span> {planStepLabel(cell)}
              </li>
            ))}
          </ol>
        </div>
      )}

      <LiveTestingPanel engagement={engagement} />
    </div>
  );
}

/** One compact plan line: `recon · code-review` or `authz-sweep · code-review ·
 * authz [triad]`. Name (or the persona) leads, then the persona, then the
 * playbook, then flags. */
function planStepLabel(cell: SecurityPlanCellWire): string {
  const parts: string[] = [cell.name ?? cell.persona];
  if (cell.name) parts.push(cell.persona);
  if (cell.playbook) parts.push(cell.playbook);
  let label = parts.join(" · ");
  const flags: string[] = [];
  if (cell.triad) flags.push("triad");
  if (cell.review) flags.push("verify");
  if (flags.length > 0) label += ` [${flags.join(", ")}]`;
  return label;
}
