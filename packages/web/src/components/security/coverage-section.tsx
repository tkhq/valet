import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { SecurityCellWire, SecurityCoverageWire } from "@valet/api/wire";
import { cn } from "~/lib/cn";

/**
 * The coverage-honesty section (NOT_ASSESSED ledger, M-P2d, spec §Coverage
 * honesty). A gap is a hole the team should know about ("secrets not scanned
 * because gitleaks is missing"), never a silent skip.
 *
 * Rich but compact: a summary bar, a tab per status (the actionable gaps and
 * the assessed areas), and pagination so a long ledger stays a few rows tall.
 * Renders nothing when the ledger is empty.
 */

const PAGE_SIZE = 5;
type Tab = "gaps" | "assessed";

export function CoverageSection({
  coverage,
  cells,
}: {
  coverage: SecurityCoverageWire[];
  cells: SecurityCellWire[];
}) {
  const gaps = coverage.filter((c) => c.status === "not_assessed");
  const assessed = coverage.filter((c) => c.status === "assessed");
  const cellDir = useMemo(() => new Map(cells.map((c) => [c.id, c.dir])), [cells]);
  // Default to the actionable gaps when there are any; the ledger is present at
  // mount (the panel gates on the loaded query), so this reads correctly once.
  const [tab, setTab] = useState<Tab>(() => (gaps.length > 0 ? "gaps" : "assessed"));
  const [page, setPage] = useState(0);

  if (coverage.length === 0) return null;

  const rows = tab === "gaps" ? gaps : assessed;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clamped = Math.min(page, pageCount - 1);
  const start = clamped * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  function selectTab(next: Tab) {
    setTab(next);
    setPage(0);
  }

  return (
    <section className="border-b border-line px-4 py-3" aria-label="Coverage">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-ink">Coverage</span>
        <CoverageBar assessed={assessed.length} notAssessed={gaps.length} />
        <span className="tabular-nums text-muted">
          {assessed.length} assessed · {gaps.length} not assessed
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1 text-[11px]">
        <TabButton active={tab === "gaps"} tone="amber" onClick={() => selectTab("gaps")}>
          Not assessed <span className="tabular-nums">{gaps.length}</span>
        </TabButton>
        <TabButton active={tab === "assessed"} tone="neutral" onClick={() => selectTab("assessed")}>
          Assessed <span className="tabular-nums">{assessed.length}</span>
        </TabButton>
      </div>

      {rows.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted">
          {tab === "gaps"
            ? "No coverage gaps — every planned check ran."
            : "No assessed areas recorded yet."}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {pageRows.map((row) =>
            tab === "gaps" ? (
              <GapRow key={row.id} row={row} cellDir={cellDir.get(row.cellId)} />
            ) : (
              <AssessedRow key={row.id} row={row} cellDir={cellDir.get(row.cellId)} />
            ),
          )}
        </ul>
      )}

      {rows.length > PAGE_SIZE && (
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
          <span className="tabular-nums">
            {start + 1}–{Math.min(start + PAGE_SIZE, rows.length)} of {rows.length}
          </span>
          <div className="flex items-center gap-1">
            <PagerButton disabled={clamped === 0} onClick={() => setPage(clamped - 1)} label="Previous page">
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </PagerButton>
            <span className="tabular-nums">
              {clamped + 1}/{pageCount}
            </span>
            <PagerButton
              disabled={clamped >= pageCount - 1}
              onClick={() => setPage(clamped + 1)}
              label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </PagerButton>
          </div>
        </div>
      )}
    </section>
  );
}

/** A thin two-segment bar: assessed (success) vs not-assessed (amber). */
function CoverageBar({ assessed, notAssessed }: { assessed: number; notAssessed: number }) {
  const total = assessed + notAssessed;
  if (total === 0) return null;
  return (
    <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-line" aria-hidden>
      {assessed > 0 && (
        <div className="bg-success-500" style={{ width: `${(assessed / total) * 100}%` }} />
      )}
      {notAssessed > 0 && (
        <div className="bg-amber-500" style={{ width: `${(notAssessed / total) * 100}%` }} />
      )}
    </div>
  );
}

function TabButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: "amber" | "neutral";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5",
        active
          ? tone === "amber"
            ? "bg-amber-500/15 font-medium text-amber-800 dark:text-amber-300"
            : "bg-ink-wash font-medium text-ink"
          : "text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function GapRow({ row, cellDir }: { row: SecurityCoverageWire; cellDir?: string }) {
  return (
    <li className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-ink">{row.area}</span>
        {cellDir && <span className="font-mono text-muted">{cellDir}</span>}
        {row.tool && (
          <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[10px] text-amber-800 dark:text-amber-300">
            {row.tool}
          </span>
        )}
      </div>
      {row.reason && <div className="mt-0.5 text-muted">{row.reason}</div>}
    </li>
  );
}

function AssessedRow({ row, cellDir }: { row: SecurityCoverageWire; cellDir?: string }) {
  return (
    <li className="flex flex-wrap items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-[11px]">
      <Check className="h-3 w-3 shrink-0 text-success-600 dark:text-success-500" aria-hidden />
      <span className="text-ink">{row.area}</span>
      {cellDir && <span className="font-mono text-muted">{cellDir}</span>}
      {row.tool && (
        <span className="rounded bg-ink-wash px-1 py-0.5 text-[10px] text-muted">{row.tool}</span>
      )}
    </li>
  );
}

function PagerButton({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="rounded p-0.5 text-muted hover:bg-ink-wash hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
