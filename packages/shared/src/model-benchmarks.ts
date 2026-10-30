/**
 * Dated benchmark snapshot for the model comparison page
 * (docs/specs/2026-10-30-model-comparison-page-design.md).
 *
 * The data lives in `model-benchmarks.json` beside this module so the eval
 * script (`scripts/evals/snapshot-benchmarks.mjs`) can rewrite it as a
 * document. Refreshing is a PR that edits the JSON and bumps `asOf`.
 *
 * Ids are the bare provider ids, lower-cased, as the Bedrock and OpenRouter
 * default lists spell them (`us.zai.glm-5.3`, `deepseek/deepseek-v4-pro`).
 * Catalog ids are `${namespace}/${id}`; `benchmarkFor` strips the namespace.
 */
import snapshot from "./model-benchmarks.json" with { type: "json" };

/** One run of our own eval harness (`packages/eval`) used as a comparison
 * instrument, recorded per model family. */
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
  /** Mean USD per case across the priced run cases; absent when unpriced. */
  meanCostUsd?: number;
  /** ISO date of the run. */
  ranAt: string;
}

export interface ModelBenchmark {
  /** Stable family slug, e.g. "deepseek-v3.2". One per model version or variant. */
  family: string;
  /** Display name for the family when a catalog name is missing. */
  name: string;
  /** Catalog ids (namespace stripped, lower-cased) that are this family. */
  ids: readonly string[];
  intelligenceIndex?: number;
  /** Which Artificial Analysis index version `intelligenceIndex` is on
   * ("v5.0", "v4.1", ...). Versions are not comparable with each other;
   * Quality normalizes within a version (`intelligenceCeilings`). */
  indexVersion?: string;
  codingIndex?: number;
  /** Page or dated article the public scores were read from. */
  sourceUrl?: string;
  /** ISO date the public score was observed or the article was dated. */
  observed?: string;
  /** Caveat shown in the score tooltip (lower confidence, old index, ...). */
  note?: string;
  valetEval?: ValetEvalResult;
}

export interface ModelBenchmarksSnapshot {
  /** ISO date the public scores were read. */
  asOf: string;
  source: { label: string; url: string; version: string };
  entries: readonly ModelBenchmark[];
}

export const MODEL_BENCHMARKS_SNAPSHOT: ModelBenchmarksSnapshot = snapshot as ModelBenchmarksSnapshot;


/** Bedrock cross-region profile prefixes (`us.`, `eu.`, `global.`, ...). */
const BEDROCK_GEO_PREFIX = /^(?:global|us|eu|apac|au|jp|in|ca|sa|us-gov)\./;

/** Lower-cased id → entry, plus the geo-stripped alias of any Bedrock profile
 * id (so `us.zai.glm-5.3` also answers for `global.zai.glm-5.3`). Exact ids
 * win over aliases. */
const BY_ID: ReadonlyMap<string, ModelBenchmark> = (() => {
  const exact = new Map<string, ModelBenchmark>();
  const alias = new Map<string, ModelBenchmark>();
  for (const entry of MODEL_BENCHMARKS_SNAPSHOT.entries) {
    for (const raw of entry.ids) {
      const id = raw.toLowerCase();
      exact.set(id, entry);
      const geo = BEDROCK_GEO_PREFIX.exec(id);
      if (geo) alias.set(id.slice(geo[0].length), entry);
    }
  }
  return new Map([...alias, ...exact]);
})();

/**
 * The benchmark family for a catalog id. Drops the provider namespace (the
 * text up to and including the first `/`), lower-cases, and looks up; a bare
 * id with no `/` is looked up as is (legacy Anthropic ids).
 */
export function benchmarkFor(catalogId: string): ModelBenchmark | undefined {
  const slash = catalogId.indexOf("/");
  const bare = (slash === -1 ? catalogId : catalogId.slice(slash + 1)).toLowerCase();
  const exact = BY_ID.get(bare);
  if (exact) return exact;
  // Bedrock cross-region profiles prefix the model id with a geography
  // (`us.`, `eu.`, `global.`, `us-gov.`, ...). Live discovery emits those
  // forms; the snapshot lists the bare id once.
  const geo = BEDROCK_GEO_PREFIX.exec(bare);
  return geo ? BY_ID.get(bare.slice(geo[0].length)) : undefined;
}


/** Fewer scored entries than this and a version cannot anchor a Quality score. */
export const MIN_SCORED_PER_VERSION = 3;

/**
 * Best `intelligenceIndex` per `indexVersion`, for versions with at least
 * `MIN_SCORED_PER_VERSION` scored entries. A version with fewer entries
 * (one old article, say) has no ceiling and so contributes no Quality.
 */
export function intelligenceCeilings(snap: ModelBenchmarksSnapshot = MODEL_BENCHMARKS_SNAPSHOT): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const maxes = new Map<string, number>();
  for (const entry of snap.entries) {
    const v = entry.intelligenceIndex;
    const version = entry.indexVersion;
    if (typeof v !== "number" || !Number.isFinite(v) || !version) continue;
    counts.set(version, (counts.get(version) ?? 0) + 1);
    const current = maxes.get(version);
    if (current === undefined || v > current) maxes.set(version, v);
  }
  const out = new Map<string, number>();
  for (const [version, n] of counts) if (n >= MIN_SCORED_PER_VERSION) out.set(version, maxes.get(version)!);
  return out;
}

/** Version string "vX.Y(.Z)" as a comparable tuple; non-matching strings sort first. */
function versionTuple(v: string): number[] {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(v.trim());
  return m ? m[1].split(".").map(Number) : [-1];
}

/**
 * The index version that anchors Quality: the newest version with a ceiling
 * (`MIN_SCORED_PER_VERSION` scored entries). A single early score on a newer
 * version therefore does not demote every current score to display-only;
 * the switch happens once the newer version has enough entries.
 */
export function latestIndexVersion(snap: ModelBenchmarksSnapshot = MODEL_BENCHMARKS_SNAPSHOT): string | undefined {
  let best: string | undefined;
  for (const version of intelligenceCeilings(snap).keys()) {
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

function compareVersions(a: string, b: string): number {
  const ta = versionTuple(a);
  const tb = versionTuple(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const d = (ta[i] ?? 0) - (tb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
