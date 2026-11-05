/**
 * Model comparison table (docs/specs/2026-10-30-model-comparison-page-design.md).
 *
 * Read-only. Joins `GET /api/models` (active models every member can see)
 * with the dated benchmark snapshot in `@valet/shared` and derives Quality
 * and Value in `lib/model-value.ts`. Missing data renders as a dash, never
 * as $0 or 0. Mounted on the personal rail and as an org tab.
 */
import { useMemo, useState } from "react";
import { MODEL_BENCHMARKS_SNAPSHOT, type ModelBenchmark } from "@valet/shared";
import { Badge, Checkbox, FilterChips, Input, Spinner } from "~/components/primitives";
import { useModels } from "~/api/settings";
import { formatContext, formatRate, formatUsdPrecise } from "~/lib/format-usage";
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
  type RowFilter,
  type SortKey,
} from "~/lib/model-value";

const ALL_PROVIDERS = "__all__";

const qualityHelp = (latest: string | undefined) =>
  `Quality is the mean of the parts we have: the Artificial Analysis Intelligence Index as a share of the best ${latest ?? "current-version"} score in our snapshot (only ${latest ?? "current-version"} scores count; older index versions are shown but not scored, because the index is re-based and retired models are not re-run), and the pass rate of Valet's own hard eval suite.`;
const VALUE_HELP =
  "Value is Quality squared divided by the blended price, rescaled so the best model in your catalog is 100. Squaring weights quality about twice as much as price. Filtering does not change it.";
const PRICE_HELP = "Provider list prices per million tokens. Your bill may differ by region or tier.";

const SOURCE_LABEL: Record<QualitySource, string> = { aa: "Artificial Analysis", valet: "Valet eval" };
const SOURCE_BADGE: Record<QualitySource, string> = { aa: "AA", valet: "Valet" };

type Column = {
  key: SortKey | "approved";
  label: string;
  title?: string;
  numeric: boolean;
  sortable: boolean;
};

/** First click sorts best-first on a score column and cheapest-first elsewhere. */
const SCORE_KEYS: ReadonlySet<string> = new Set(["intelligence", "coding", "valetEval", "quality", "value"]); // evalCost sorts cheapest-first like prices

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
  const [provider, setProvider] = useState<string>(ALL_PROVIDERS);
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const scoring = useMemo(() => scoringForTests ?? defaultQualityScoring(), [scoringForTests]);
  const rows = useMemo(
    () => buildRows(modelsQ.data?.models ?? [], { lookup: lookupForTests, ...scoring }),
    [modelsQ.data, lookupForTests, scoring],
  );
  // Older-version and unscored models are hidden by default; when nothing
  // in the catalog has a current score the default view would be empty, so
  // the table shows everything instead and the toggle disappears.
  const anyCurrent = rows.some((r) => isCurrentScore(r.benchmark, scoring) || r.benchmark?.valetEval !== undefined);
  const currentOnly = anyCurrent && !showHidden;
  const base: RowFilter = { needle: filter, provider: provider === ALL_PROVIDERS ? undefined : provider, approvedOnly };
  const shown = useMemo(
    () => sortRows(filterRows(rows, { ...base, currentOnly, scoring }), sort.key, sort.dir),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `base` is rebuilt each render from its scalar parts
    [rows, filter, provider, approvedOnly, currentOnly, scoring, sort],
  );
  const hiddenCount = anyCurrent ? filterRows(rows, base).length - filterRows(rows, { ...base, currentOnly: true, scoring }).length : 0;
  const providers = useMemo(() => [...new Set(rows.map((r) => r.model.providerName))].sort((a, b) => a.localeCompare(b)), [rows]);

  const showApproved = rows.some((r) => r.model.approved === false);
  const showCoding = rows.some((r) => r.benchmark?.codingIndex !== undefined);
  const { asOf, source } = MODEL_BENCHMARKS_SNAPSHOT;

  const columns: Column[] = [
    { key: "name", label: "Model", numeric: false, sortable: true },
    { key: "input", label: "Input", title: PRICE_HELP, numeric: true, sortable: true },
    { key: "output", label: "Output", title: PRICE_HELP, numeric: true, sortable: true },
    { key: "blended", label: "Blended", title: "(3 × input + output) / 4, the Artificial Analysis convention.", numeric: true, sortable: true },
    { key: "context", label: "Context", numeric: true, sortable: true },
    { key: "intelligence", label: "Intelligence", title: `${source.label} Intelligence Index. Hover a score for its index version and source.`, numeric: true, sortable: true },
    ...(showCoding ? [{ key: "coding", label: "Coding", title: `${source.label} Coding Index.`, numeric: true, sortable: true } as Column] : []),
    { key: "valetEval", label: "Valet eval", title: "Pass rate on Valet's own hard eval suite. Hover for the run.", numeric: true, sortable: true },
    { key: "evalCost", label: "Eval $/case", title: "Measured mean cost of one run of one hard-suite case, from the same eval. Captures verbosity and retries that list price cannot.", numeric: true, sortable: true },
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
        . Prices are provider list prices in $ per 1M tokens; your bill may differ by region or tier.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Input
          aria-label="Filter models"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by model, id or provider…"
          className="w-full sm:w-72"
        />
        {providers.length > 1 && (
          <FilterChips
            label="Provider"
            value={provider}
            onChange={setProvider}
            options={[{ value: ALL_PROVIDERS, label: "All providers" }, ...providers.map((p) => ({ value: p, label: p }))]}
          />
        )}
        {showApproved && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <Checkbox checked={approvedOnly} onCheckedChange={setApprovedOnly} aria-label="Approved only" />
            Approved only
          </label>
        )}
        {anyCurrent && hiddenCount > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <Checkbox
              checked={showHidden}
              onCheckedChange={setShowHidden}
              aria-label={`Show ${hiddenCount} hidden (older index versions or not benchmarked)`}
            />
            Show {hiddenCount} hidden (older index versions or not benchmarked)
          </label>
        )}
        {anyCurrent && hiddenCount === 0 && showHidden && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <Checkbox checked onCheckedChange={setShowHidden} aria-label="Show hidden models" />
            Showing all models
          </label>
        )}
      </div>
      {modelsQ.isLoading && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted">
          <Spinner size={14} /> Loading models…
        </div>
      )}
      {modelsQ.error != null && <p className="text-xs text-danger-500">Failed to load models.</p>}
      {!modelsQ.isLoading && modelsQ.error == null && (
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-ink-wash/40 text-muted">
                {columns.map((col) => {
                  const active = col.sortable && sort.key === col.key;
                  const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={ariaSort}
                      title={col.title}
                      className={`whitespace-nowrap px-2 py-2 font-medium ${col.numeric ? "text-right" : ""} ${col.key === "name" ? "pl-3" : ""}`}
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
  const num = "px-2 py-2 text-right align-top tabular-nums";
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
      <td className="max-w-[16rem] px-2 py-2 pl-3 align-top">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-ink" data-model-name>
            {model.name}
          </span>
          {model.reasoning && <Badge variant="neutral">reasoning</Badge>}
        </div>
        <div className="truncate text-[11px] text-muted" title={model.id}>
          {model.providerName} · <span className="font-mono">{model.id.slice(model.id.indexOf("/") + 1)}</span>
        </div>
      </td>
      <td className={num}>{formatRate(row.input) ?? DASH}</td>
      <td className={num}>{formatRate(row.output) ?? DASH}</td>
      <td className={num}>{formatRate(row.blended) ?? DASH}</td>
      <td className={num}>{formatContext(model.contextWindow) ?? DASH}</td>
      <td className={`${num} whitespace-nowrap`} title={scoreTitle}>
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
      <td className={num}>{ev?.meanCostUsd !== undefined && ev.meanCostUsd > 0 ? formatUsdPrecise(ev.meanCostUsd) : DASH}</td>
      <td className={`${num} whitespace-nowrap`} title={qualityTitle}>
        {row.quality !== undefined ? (
          <>
            {row.quality}
            <span className="ml-1 text-[10px] text-muted">{row.qualitySources.map((s) => SOURCE_BADGE[s]).join(" + ")}</span>
          </>
        ) : (
          DASH
        )}
      </td>
      <td className={`${num} text-sm font-semibold text-ink`}>{row.value !== undefined ? row.value : DASH}</td>
      {showApproved && <td className="px-2 py-2 text-muted">{unapproved ? "No" : "Yes"}</td>}
    </tr>
  );
}
