/**
 * Pure helpers behind the model comparison page
 * (docs/specs/2026-10-30-model-comparison-page-design.md): the blended
 * price, the derived Quality and Value indices, and sort/filter over rows.
 */
import type { ModelInfo } from "@valet/api/wire";
import { benchmarkFor, intelligenceCeilings, latestIndexVersion, type ModelBenchmark } from "@valet/shared";

/** What a missing cell renders as (an en dash, never "$0" or "0"). */
export const DASH = "–";

export type SortKey =
  | "value"
  | "quality"
  | "input"
  | "output"
  | "blended"
  | "context"
  | "intelligence"
  | "coding"
  | "valetEval"
  | "name";

export type QualitySource = "aa" | "valet";

export interface ComparisonRow {
  model: ModelInfo;
  benchmark?: ModelBenchmark;
  input?: number;
  output?: number;
  /** (3 * input + output) / 4, only when both prices are positive. */
  blended?: number;
  /** 0 to 100, mean of the available parts (see `qualityOf`). */
  quality?: number;
  qualitySources: QualitySource[];
  /** 0 to 100 across the rows built together: quality² / blended, best = 100. */
  value?: number;
}

const positive = (n: number | undefined): number | undefined => (n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined);

/** 3:1 input:output blend, the Artificial Analysis convention. */
export function blendedPrice(pricing: ModelInfo["pricing"]): number | undefined {
  const input = positive(pricing?.input);
  const output = positive(pricing?.output);
  if (input === undefined || output === undefined) return undefined;
  return (3 * input + output) / 4;
}

/** What anchors the public part of Quality: per-version ceilings and the
 * newest index version. Only scores on the newest version count. */
export interface QualityScoring {
  ceilings: ReadonlyMap<string, number>;
  latestVersion: string | undefined;
}

export function defaultQualityScoring(): QualityScoring {
  return { ceilings: intelligenceCeilings(), latestVersion: latestIndexVersion() };
}

/** True when a benchmark's public score is on the newest index version. */
export function isCurrentScore(benchmark: ModelBenchmark | undefined, scoring: QualityScoring): boolean {
  return benchmark?.indexVersion !== undefined && benchmark.indexVersion === scoring.latestVersion;
}

/**
 * Quality is the rounded mean of the parts that exist: the public score as a
 * share of its version's ceiling, only when that version is the newest one
 * (Artificial Analysis re-bases the index and does not re-run retired
 * models, so an older era's share would outrank a successor), and our own
 * eval pass rate.
 */
export function qualityOf(
  benchmark: ModelBenchmark | undefined,
  scoring: QualityScoring,
): { quality: number | undefined; sources: QualitySource[] } {
  const parts: number[] = [];
  const sources: QualitySource[] = [];
  if (benchmark) {
    const ceiling = isCurrentScore(benchmark, scoring) ? scoring.ceilings.get(benchmark.indexVersion!) : undefined;
    if (positive(benchmark.intelligenceIndex) !== undefined && ceiling !== undefined) {
      parts.push((100 * benchmark.intelligenceIndex!) / ceiling);
      sources.push("aa");
    }
    const pass = benchmark.valetEval?.passRate;
    if (pass !== undefined && Number.isFinite(pass)) {
      parts.push(pass);
      sources.push("valet");
    }
  }
  if (parts.length === 0) return { quality: undefined, sources };
  return { quality: Math.round(parts.reduce((a, b) => a + b, 0) / parts.length), sources };
}

export function buildRows(
  models: ModelInfo[],
  opts: Partial<QualityScoring> & { lookup?: (catalogId: string) => ModelBenchmark | undefined } = {},
): ComparisonRow[] {
  const defaults = opts.ceilings === undefined || !("latestVersion" in opts) ? defaultQualityScoring() : undefined;
  const scoring: QualityScoring = {
    ceilings: opts.ceilings ?? defaults!.ceilings,
    latestVersion: "latestVersion" in opts ? opts.latestVersion : defaults!.latestVersion,
  };
  const lookup = opts.lookup ?? benchmarkFor;
  const rows: ComparisonRow[] = models.map((model) => {
    const benchmark = lookup(model.id);
    const { quality, sources } = qualityOf(benchmark, scoring);
    return {
      model,
      benchmark,
      input: positive(model.pricing?.input),
      output: positive(model.pricing?.output),
      blended: blendedPrice(model.pricing),
      quality,
      qualitySources: sources,
    };
  });
  const raw = rows.map((r) => (r.quality !== undefined && r.blended !== undefined ? (r.quality * r.quality) / r.blended : undefined));
  const max = raw.reduce<number>((m, v) => (v !== undefined && v > m ? v : m), 0);
  if (max > 0) {
    raw.forEach((v, i) => {
      if (v !== undefined) rows[i].value = Math.round((100 * v) / max);
    });
  }
  return rows;
}

function keyValue(row: ComparisonRow, key: SortKey): number | string | undefined {
  switch (key) {
    case "value": return row.value;
    case "quality": return row.quality;
    case "input": return row.input;
    case "output": return row.output;
    case "blended": return row.blended;
    case "context": return positive(row.model.contextWindow);
    case "intelligence": return positive(row.benchmark?.intelligenceIndex);
    case "coding": return positive(row.benchmark?.codingIndex);
    case "valetEval": return row.benchmark?.valetEval?.passRate;
    case "name": return row.model.name.toLowerCase();
  }
}

/** Compare two optional values; `undefined` sorts last in either direction. */
function compare(a: number | string | undefined, b: number | string | undefined, dir: "asc" | "desc"): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const base = typeof a === "string" || typeof b === "string" ? String(a).localeCompare(String(b)) : a - b;
  return dir === "asc" ? base : -base;
}

/**
 * Stable sort on one key. The default key, "value", carries the spec's
 * tie-break chain (quality desc, blended asc, name asc); other keys break
 * ties by name. Returns a new array.
 */
export function sortRows(rows: ComparisonRow[], key: SortKey, dir: "asc" | "desc"): ComparisonRow[] {
  const byName = (a: ComparisonRow, b: ComparisonRow) => compare(keyValue(a, "name"), keyValue(b, "name"), "asc");
  return rows.slice().sort((a, b) => {
    const primary = compare(keyValue(a, key), keyValue(b, key), dir);
    if (primary !== 0) return primary;
    if (key === "value") {
      return (
        compare(a.quality, b.quality, "desc") ||
        compare(a.blended, b.blended, "asc") ||
        byName(a, b)
      );
    }
    return byName(a, b);
  });
}

/** Case-insensitive substring match over name, id and provider name. */
export function filterRows(rows: ComparisonRow[], needle: string): ComparisonRow[] {
  const q = needle.trim().toLowerCase();
  if (q === "") return rows;
  return rows.filter((r) => [r.model.name, r.model.id, r.model.providerName].some((s) => s.toLowerCase().includes(q)));
}
