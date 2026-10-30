# Model comparison page

Status: approved 2026-10-30 (Conner). Author: Conner with Claude.

## Intent

Valet now exposes dozens of models across Anthropic, OpenAI, OpenRouter and Amazon Bedrock, and the price gap between them is an order of magnitude. Nobody picking a model in the composer, and no admin curating the catalog, can see what a model costs or how it ranks without leaving Valet. One page should answer "which of our models is best for the money" for everyone in the org.

## Goals

- Every member can open one page listing the models the org has enabled, with list price, context window, reasoning support, and benchmark standing side by side.
- Admins reach the same page from the organization Models area, next to the card where they curate the catalog.
- Benchmark numbers carry a visible "as of" date and a source, and never read as more current than they are.
- Zero new runtime dependencies and no new outbound calls.

## Non-goals

- Live benchmark feeds. The snapshot is a file in the repo, refreshed by PR (Conner's decision, 2026-10-30, over a live Artificial Analysis API).
- Changing which models the org has. Curation stays on the existing Bedrock and OpenRouter cards and the approved-models section.
- Per-org usage analytics. The Usage page already covers spend; this page is about list prices and quality.
- Custom `openai_compatible` providers get price and context when the row has them, and no benchmark unless an id happens to match.

## Anti-goals

- A page that shows "$0" or a blank score in a way that reads as "free" or "scored zero". Missing data is shown as missing.
- Rankings that look authoritative while being stale. The date and source sit in the table header, not a footnote.

## What the page shows

One component, `ModelComparisonTable`, mounted at two routes. `/settings/model-comparison` is a personal rail item labelled "Model comparison" (bar-chart icon, placed after the existing Models or Appearance item) that every member sees in both org mode and single-user mode. `/settings/organization/model-comparison` is a "Compare" tab in the organization "Models and usage" group, between Models and Proxy, inside the existing `OrgRouteGuard`. The rail tests that enumerate items and tabs are updated with the two entries.

One table, one row per entry of `GET /api/models` (active models only, which is what pickers already show). Columns:

| Column | Source | Display |
|---|---|---|
| Model | `ModelInfo.name`, `id` | Name, id in muted text below |
| Provider | `providerName` | plain text |
| Input $/M | `pricing.input` | `$0.62`; sub-cent keeps a third decimal; missing shows a dash |
| Output $/M | `pricing.output` | same |
| Blended $/M | 3:1 input:output, the Artificial Analysis convention | `$0.93`; shown only when both prices are known |
| Context | `contextWindow` | `262k`, `1M` |
| Reasoning | `reasoning` | check mark or empty |
| Intelligence | snapshot `intelligenceIndex` | integer; dash when the model is not in the snapshot |
| Coding | snapshot `codingIndex` | same; the column renders only when some shown row has a value (Artificial Analysis folded coding into the v5.0 index and publishes no standalone score today) |
| Valet eval | snapshot `valetEval.passRate` | `87%`, tooltip with suite, cases, runs, reasoning level, mean cost per case and run date; dash when no run is recorded |
| Quality | derived, see below | integer 0 to 100 followed by a small inline badge naming its sources (AA, Valet, or AA + Valet) |
| Value | derived, see below | integer 0 to 100; dash when Quality or blended price is missing |
| Approved | `approved` | shown only when at least one listed model has `approved: false` (the list is `null`-means-all, so the column is meaningless otherwise, and absent in single-user mode); unapproved rows render dim |

Blended $/M is `(3 * input + output) / 4` (3:1 input:output), formatted with the same rule as the other price columns.

Quality and Value are computed on the client from the snapshot and the row's prices, in a pure, tested helper (`lib/model-value.ts`):

- `quality = round(mean of the available parts)`, where the parts are `100 * intelligenceIndex / ceiling(indexVersion)` and `valetEval.passRate` (already 0 to 100). With one part, that part is the Quality. With neither, Quality is undefined. The ceiling is the best score in the snapshot on the same index version (`intelligenceCeilings`), not over the org's catalog, so a small catalog does not inflate its best model to 100.
- Artificial Analysis re-bases its Intelligence Index several times a year (v4.0, v4.1, v4.3, v5.0 in 2026) and does not re-run retired models, so most of our models only have a score on an older version and the versions are not comparable (DeepSeek V4 Pro reads 52, 44, 36 and 23 across them). Each entry records its `indexVersion`. Only scores on the newest version in the snapshot (`latestIndexVersion`) feed Quality, and only when that version has at least three scored entries to set its ceiling. Older scores are displayed with their version beside the number and feed nothing: a review of the first cut showed that "share of that era's best" ranked GLM-5 above GLM-5.3 and GPT-5.4 above GPT-5.5, which is the anti-goal above. A model with an entry but no score reads "not yet benchmarked"; a model with no entry shows a dash.
- `valueRaw = quality^2 / blendedPrice`; `value = round(100 * valueRaw / max valueRaw across the org's catalog)`. Filtering does not rescale it, so a number means the same thing before and after a search; the help text says "best model in your catalog is 100". Squaring weights quality about twice as much as price; a plain quality-per-dollar ratio would always crown the cheapest passable model. Rows missing Quality or a blended price have no Value. The header tooltip states both formulas in one sentence each so the number is never mistaken for an industry metric.

Default sort: Value descending, then Quality descending, then blended price ascending, then name. Rows missing the sorted value go last in either direction. Every numeric column header toggles sort. A single filter box matches name, id and provider.

Above the table: "Benchmarks: Artificial Analysis Intelligence Index v4.3 and Coding Index, snapshot of 2026-10-30" with a link to the source and the sentence "Prices are provider list prices per million tokens; your bill may differ by region or tier." The date and version come from the snapshot file, not from copy.

The page is read only. Nothing on it writes.

## The snapshot

The data lives in `packages/shared/src/model-benchmarks.json` (so the eval script rewrites a document, not source) and `packages/shared/src/model-benchmarks.ts` types it and exports:

```ts
export interface ModelBenchmark {
  /** Stable family slug, e.g. "deepseek-v3.2". */
  family: string;
  /** Display name for the family when a catalog name is missing. */
  name: string;
  /** Catalog ids that are this family, across providers, lower-cased. Bedrock
   * ids include their `us.` profile form; OpenRouter ids keep the slash. */
  ids: readonly string[];
  intelligenceIndex?: number;
  /** Artificial Analysis index version the score is on ("v5.0", "v4.1"). */
  indexVersion?: string;
  codingIndex?: number;
  sourceUrl?: string;
  /** ISO date the score was observed or the source article was dated. */
  observed?: string;
  note?: string;
  /** Our own eval harness, `packages/eval`, run as a comparison instrument. */
  valetEval?: ValetEvalResult;
}
export interface ValetEvalResult {
  /** Suite directory as passed to the runner, e.g. "evals/cases/hard". */
  suite: string;
  /** Model spec the runner used (`provider/model`). */
  modelSpec: string;
  reasoning?: string;
  cases: number;
  runsPerCase: number;
  /** Passed cases over run cases, 0 to 100. Skipped cases are excluded. */
  passRate: number;
  /** Mean USD per case across the run cases; absent when unpriced. */
  meanCostUsd?: number;
  /** ISO date of the run. */
  ranAt: string;
}
export const MODEL_BENCHMARKS_SNAPSHOT: {
  asOf: "2026-10-30";
  source: { label: string; url: string; version: string };
  entries: readonly ModelBenchmark[];
};
export function benchmarkFor(modelId: string): ModelBenchmark | undefined;
/** Best score per index version, for versions with >= 3 scored entries. */
export function intelligenceCeilings(snapshot?): ReadonlyMap<string, number>;
```

Catalog ids from `GET /api/models` are `${namespace}/${modelId}` where the namespace is the provider kind (`anthropic`, `openai`, `google`, `openrouter`, `amazon-bedrock`) or the row id for `openai_compatible` (`services/llm-providers.ts`, `providerNamespace`). So OpenRouter ids nest (`openrouter/deepseek/deepseek-v4-pro`) and Bedrock ids keep their profile form (`amazon-bedrock/us.zai.glm-5.3`). `benchmarkFor` splits on the first `/`, drops that namespace, lower-cases the remainder, and looks it up in a map built once from every `ids` entry. When the exact id misses and it starts with a Bedrock geography prefix (`us.`, `eu.`, `global.`, `us-gov.`, ...), the prefix is stripped and the bare id is tried; the map also indexes the geo-stripped alias of any listed profile id, so a model that exists on Bedrock only as a profile (`us.zai.glm-5.3`) answers for every geography. Snapshot `ids` must each be a real id in some pi-ai registry; an api test enforces that so a vendor rename cannot leave a scored model showing a dash. It is pure and tested.

Each model version or variant is its own family (`kimi-k2.6` and `kimi-k2-thinking` are two entries), because the benchmark sites score them separately.

The first snapshot covers every model in the Bedrock and OpenRouter default sets, the current Anthropic and OpenAI direct models, and the four frontier open models compared on 2026-10-30 (Kimi K3, GLM-5.3, DeepSeek V3.2, Mistral Large 3). Scores are the Artificial Analysis Intelligence Index, each on the version its source published (five models have live v5.0 scores on the snapshot date; the rest come from dated AA articles on v4.0 or v4.1, two from undated cached AA pages on v4.3.2 and are marked lower confidence in `note`). No Coding Index is published for any of them. The numbers are researched before the build and shipped in the first PR; a model whose score cannot be found from Artificial Analysis or a source quoting it with a date is listed with ids and no scores rather than guessed or left out, so a later PR only has to fill in numbers. The page says "not yet benchmarked" for such rows.

### Internal eval results

`packages/eval` already runs `evals/cases/hard` as a cross-model comparison instrument (its README forbids wiring it into CI as a gate) and `--json` emits per-case status, cost and tokens. A script, `scripts/evals/snapshot-benchmarks.mjs`, reads that JSON from stdin plus `--family <slug> --model <spec> [--reasoning <level>] --suite <dir>`, computes `passRate` as passed runs over all runs of the non-skipped cases (the runner's `costUsd` is a total across runs and its case status is thresholded, so both are normalised per run), `meanCostUsd` as the mean single-run cost over priced cases, and writes or replaces the family's `valetEval` block in `packages/shared/src/model-benchmarks.json` with today's date, preserving the file's one-entry-per-line layout so the refresh is a one-line diff. The runner must be invoked with `pnpm --silent`, or pnpm's banner lands in the JSON. Refreshing is "run the hard suite for a model, pipe the JSON into the script, open a PR." The first PR ships the type, the column and the script with every `valetEval` absent; populating it means running the suite against each model with provider keys and Docker, which is a separate session and real spend.

Refreshing the snapshot is a PR that edits the file and bumps `asOf`. A unit test asserts every id in `BEDROCK_DEFAULT_MODEL_IDS` and `OPENROUTER_DEFAULT_MODEL_IDS` has a snapshot entry, so a new default cannot ship unbenchmarked without a deliberate change to that test.

## Shared package wiring

`packages/shared/src/index.ts` re-exports the new module, so web imports it from `@valet/shared` like `repo-sandbox-resources-form` does today. Web resolves shared through its `dist` exports; CI runs `pnpm exec tsc --build --noCheck` before the test shards and `pnpm typecheck` (`tsc --build`) before the web build, so shared is built first in both jobs. Locally, `pnpm --filter @valet/shared build` must run before the web suite sees the new export; the plan's first task does that and says so.

## Why shared, not api or web

The web page is the only consumer today, but the engine's model picker and the api's catalog could both use the same scores later (ranking suggestions, a "value" sort in the composer). Putting the data and matcher in `@valet/shared` keeps one source without an endpoint. The api's `buildOrgCatalog` is unchanged.

## Access

`GET /api/models` is already open to every authenticated member and returns only active models, so the page needs no new route or permission. The organization-area tab renders inside the existing `OrgRouteGuard`.

## Decided by the builder

- Table component and sort/filter helpers follow whatever the Usage and Proxy pages already use; no new table library.
- Price formatting: a new exported `formatRate(n)` in `lib/format-usage.ts` renders one per-million rate (`$0.62`, third decimal below a cent, undefined for a non-positive or missing number); `formatPerMillion` is refactored to call it with no change to its outputs. A `formatContext` helper renders `131072` as `131k` and `1000000` as `1M`.
- Column widths and the phone layout: on narrow screens the table scrolls horizontally; the Model column is sticky.

## Exit criteria

- A member in org mode sees "Model comparison" in the rail, opens it, and sees every model from the composer picker with prices, context and, for the defaults, two benchmark scores, a Quality and a Value, and the snapshot date. The Valet eval column shows dashes until a run is recorded.
- Piping a saved `--json` run of the hard suite into `scripts/evals/snapshot-benchmarks.mjs` fills that family's `valetEval` block and the page then shows its pass rate and folds it into Quality.
- An admin sees the same table as a tab beside Models.
- A Bedrock row model with no registry price shows dashes in the three price columns, not $0.
- Removing a default from the snapshot fails the shared unit test.
- Web and shared suites pass.

## Amendment 2026-10-30 (b): layout, filters and the default view

Conner's review of the first deployed page: the sticky Model column covered the price columns, long ids wrapped rows to three lines, and the settings column's 48rem cap wasted the screen. Changes:

- **One Model cell.** Name on the first line with a small "reasoning" badge when the model reasons; provider and the bare id (namespace stripped, monospace, truncated with the full catalog id as the tooltip) on the second line. The Provider and Reasoning columns are gone. No sticky column; the table sits in a bordered, horizontally scrollable container that it rarely needs.
- **Short headers.** Input, Output, Blended, Context, Intelligence, Coding, Valet eval, Quality, Value, Approved; the caption carries the unit ("$ per 1M tokens"). Value is set larger and bolder than its neighbours. First click on a price or context header sorts ascending, on a score header descending.
- **Wide layout.** `/settings/model-comparison` and `/settings/organization/model-comparison` drop the settings column's `max-w-3xl`; other settings pages keep it (`WIDE_SETTINGS_ROUTES` in the settings layout).
- **Default view hides what cannot be compared.** A row shows by default only when its public score is on the newest index version or it has a Valet eval result. Older-version scores and unscored or unknown models are hidden behind "Show N hidden (older index versions or not benchmarked)". When nothing in the catalog qualifies, the table shows everything and the toggle is absent, so the page is never empty by default.
- **Filters.** Text filter (name, id, provider); provider chips (shown when more than one provider is present); "Approved only" (shown when the org restricts models). Filters compose, and the hidden count respects the other filters.

- **Eval $/case.** The hard-suite run also measures mean cost per case per model, which captures verbosity and retries that list price cannot. It gets its own sortable column beside the pass rate (ascending first, like prices). Value stays on list price because only evaluated models have a measured cost; switching Value's cost basis to the measured number once every default is evaluated is an open option.

`filterRows` takes a structured `RowFilter` (`needle`, `provider`, `approvedOnly`, `currentOnly` + `scoring`). Value is still rescaled over the whole catalog, not the filtered rows.

## First recorded run, 2026-10-30

Hard suite (15 cases, 3 runs each) against 16 models, total spend about $9. Recorded in the snapshot's `valetEval` blocks. Two harness findings: Llama 4 Maverick cannot run in Valet at all (Bedrock rejects tool use in streaming mode, 0/45) and left the Bedrock defaults; and the three `builder-*` cases require the `write` tool to have been called, which Claude Opus 5.5 and Sonnet 5.5 fail only because they write files through a bash heredoc while passing every functional `verify_command` check. Their recorded 82% and 80% are therefore understated by up to 20 points; relaxing that assertion to "the file exists" is a follow-up for the eval cases, not this page.
