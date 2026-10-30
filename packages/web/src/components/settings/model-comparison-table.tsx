/**
 * Model comparison table (docs/specs/2026-10-30-model-comparison-page-design.md).
 *
 * Read-only. Joins `GET /api/models` (active models every member can see)
 * with the dated benchmark snapshot in `@valet/shared` and derives Quality
 * and Value in `lib/model-value.ts`. Missing data renders as a dash, never
 * as $0 or 0. Mounted on the personal rail and as an org tab.
 */
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { MODEL_BENCHMARKS_SNAPSHOT, type ModelBenchmark } from "@valet/shared";
import { Input, Spinner } from "~/components/primitives";
import { useModels } from "~/api/settings";
import { formatContext, formatRate } from "~/lib/format-usage";
import {
  DASH,
  buildRows,
  defaultQualityScoring,
  filterRows,
  isCurrentScore,
  sortRows,
  type ComparisonRow,
  type QualityScoring,
  type QualitySource,
  type SortKey,
} from "~/lib/model-value";

const qualityHelp = (latest: string | undefined) =>
  `Quality is the mean of the parts we have: the Artificial Analysis Intelligence Index as a share of the best ${latest ?? "current-version"} score in our snapshot (only ${latest ?? "current-version"} scores count; older index versions are shown but not scored, because the index is re-based and retired models are not re-run), and the pass rate of Valet's own hard eval suite.`;
const VALUE_HELP =
  "Value is Quality squared divided by the blended price, rescaled so the best model in your catalog is 100. Squaring weights quality about twice as much as price. Filtering does not change it.";
const PRICE_HELP = "Provider list prices per million tokens. Your bill may differ by region or tier.";

const SOURCE_LABEL: Record<QualitySource, string> = { aa: "Artificial Analysis", valet: "Valet eval" };
const SOURCE_BADGE: Record<QualitySource, string> = { aa: "AA", valet: "Valet" };

type Column = {
  key: SortKey | "provider" | "reasoning" | "approved";
  label: string;
  title?: string;
  numeric: boolean;
  sortable: boolean;
};

/** First click sorts best-first on a score column and cheapest-first elsewhere. */
const SCORE_KEYS: ReadonlySet<string> = new Set(["intelligence", "coding", "valetEval", "quality", "value"]);

export function ModelComparisonTable({
  lookupForTests,
  scoringForTests,
}: {
  /** Test seam: benchmark lookup by catalog id (defaults to the bundled snapshot). */
  lookupForTests?: (catalogId: string) => ModelBenchmark | undefined;
  /** Test seam: ceilings and latest version (defaults to the bundled snapshot's). */
  scoringForTests?: QualityScoring;
}) {
  const modelsQ = useModels();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "value", dir: "desc" });
  const [filter, setFilter] = useState("");

  const scoring = useMemo(() => scoringForTests ?? defaultQualityScoring(), [scoringForTests]);
  const rows = useMemo(
    () => buildRows(modelsQ.data?.models ?? [], { lookup: lookupForTests, ...scoring }),
    [modelsQ.data, lookupForTests, scoring],
  );
  const shown = useMemo(() => sortRows(filterRows(rows, filter), sort.key, sort.dir), [rows, filter, sort]);

  const showApproved = rows.some((r) => r.model.approved === false);
  const showCoding = rows.some((r) => r.benchmark?.codingIndex !== undefined);
  const { asOf, source } = MODEL_BENCHMARKS_SNAPSHOT;

  const columns: Column[] = [
    { key: "name", label: "Model", numeric: false, sortable: true },
    { key: "provider", label: "Provider", numeric: false, sortable: false },
    { key: "input", label: "Input $/M", title: PRICE_HELP, numeric: true, sortable: true },
    { key: "output", label: "Output $/M", title: PRICE_HELP, numeric: true, sortable: true },
    { key: "blended", label: "Blended $/M", title: "(3 × input + output) / 4, the Artificial Analysis convention.", numeric: true, sortable: true },
    { key: "context", label: "Context", numeric: true, sortable: true },
    { key: "reasoning", label: "Reasoning", numeric: false, sortable: false },
    { key: "intelligence", label: "Intelligence", title: `${source.label} Intelligence Index. Hover a score for its index version and source.`, numeric: true, sortable: true },
    ...(showCoding ? [{ key: "coding", label: "Coding", title: `${source.label} Coding Index.`, numeric: true, sortable: true } as Column] : []),
    { key: "valetEval", label: "Valet eval", title: "Pass rate on Valet's own hard eval suite. Hover for the run.", numeric: true, sortable: true },
    { key: "quality", label: "Quality", title: qualityHelp(scoring.latestVersion), numeric: true, sortable: true },
    { key: "value", label: "Value", title: VALUE_HELP, numeric: true, sortable: true },
    ...(showApproved ? [{ key: "approved", label: "Approved", numeric: false, sortable: false } as Column] : []),
  ];

  function toggleSort(key: SortKey) {
    const firstDir = SCORE_KEYS.has(key) ? "desc" : "asc";
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDir }));
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Benchmarks: {source.version}, snapshot of {asOf}, from{" "}
        <a href={source.url} target="_blank" rel="noreferrer" className="underline">
          {source.label}
        </a>
        . {PRICE_HELP}
      </p>
      <Input
        aria-label="Filter models"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by model, id or provider…"
      />
      {modelsQ.isLoading && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted">
          <Spinner size={14} /> Loading models…
        </div>
      )}
      {modelsQ.error != null && <p className="text-xs text-danger-500">Failed to load models.</p>}
      {!modelsQ.isLoading && modelsQ.error == null && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-muted">
                {columns.map((col) => {
                  const active = col.sortable && sort.key === col.key;
                  const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={ariaSort}
                      title={col.title}
                      className={`py-1 pr-3 font-medium ${col.numeric ? "text-right" : ""} ${col.key === "name" ? "sticky left-0 bg-paper" : ""}`}
                    >
                      {col.sortable ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key as SortKey)}
                          className={`inline-flex items-center gap-1 hover:text-ink ${active ? "text-ink" : ""}`}
                        >
                          {col.label}
                          {active && <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span>}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <ComparisonTableRow key={row.model.id} row={row} scoring={scoring} showCoding={showCoding} showApproved={showApproved} />
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="py-3 text-xs text-muted">No matching models.</p>}
        </div>
      )}
    </div>
  );
}

function ComparisonTableRow({
  row,
  scoring,
  showCoding,
  showApproved,
}: {
  row: ComparisonRow;
  scoring: QualityScoring;
  showCoding: boolean;
  showApproved: boolean;
}) {
  const { model, benchmark } = row;
  const unapproved = model.approved === false;
  const num = "py-1.5 pr-3 text-right tabular-nums";
  const score = benchmark?.intelligenceIndex;
  const scoreTitle = benchmark
    ? [
        benchmark.indexVersion ? `Intelligence Index ${benchmark.indexVersion}` : undefined,
        benchmark.observed ? `observed ${benchmark.observed}` : undefined,
        benchmark.note,
        benchmark.sourceUrl,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const ev = benchmark?.valetEval;
  const evTitle = ev
    ? [
        ev.suite,
        `${ev.cases} cases × ${ev.runsPerCase} runs`,
        ev.reasoning ? `reasoning ${ev.reasoning}` : undefined,
        ev.meanCostUsd !== undefined ? `mean $${ev.meanCostUsd.toFixed(4)} per case` : undefined,
        `run ${ev.ranAt}`,
        ev.modelSpec,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const qualityTitle = row.qualitySources.length > 0 ? row.qualitySources.map((s) => SOURCE_LABEL[s]).join(" + ") : undefined;

  return (
    <tr className={`border-t border-line ${unapproved ? "opacity-50" : ""}`} aria-disabled={unapproved ? "true" : undefined}>
      <td className="sticky left-0 bg-paper py-1.5 pr-3 text-ink">
        <div data-model-name>{model.name}</div>
        <div className="font-mono text-[10px] text-muted">{model.id}</div>
      </td>
      <td className="py-1.5 pr-3 text-muted">{model.providerName}</td>
      <td className={num}>{formatRate(row.input) ?? DASH}</td>
      <td className={num}>{formatRate(row.output) ?? DASH}</td>
      <td className={num}>{formatRate(row.blended) ?? DASH}</td>
      <td className={num}>{formatContext(model.contextWindow) ?? DASH}</td>
      <td className="py-1.5 pr-3">{model.reasoning ? <Check className="h-3.5 w-3.5" aria-label="Reasoning" /> : null}</td>
      <td className={num} title={scoreTitle}>
        {score !== undefined ? (
          <>
            {score}
            {!isCurrentScore(benchmark, scoring) && benchmark?.indexVersion && (
              <span className="ml-1 text-[10px] text-muted">{benchmark.indexVersion}</span>
            )}
          </>
        ) : benchmark ? (
          <span className="text-muted">not yet benchmarked</span>
        ) : (
          DASH
        )}
      </td>
      {showCoding && <td className={num}>{benchmark?.codingIndex !== undefined ? benchmark.codingIndex : DASH}</td>}
      <td className={num} title={evTitle}>
        {ev ? `${Math.round(ev.passRate)}%` : DASH}
      </td>
      <td className={num} title={qualityTitle}>
        {row.quality !== undefined ? (
          <>
            {row.quality}
            <span className="ml-1 text-[10px] text-muted">{row.qualitySources.map((s) => SOURCE_BADGE[s]).join(" + ")}</span>
          </>
        ) : (
          DASH
        )}
      </td>
      <td className={`${num} font-medium text-ink`}>{row.value !== undefined ? row.value : DASH}</td>
      {showApproved && <td className="py-1.5 pr-3">{unapproved ? "No" : "Yes"}</td>}
    </tr>
  );
}
