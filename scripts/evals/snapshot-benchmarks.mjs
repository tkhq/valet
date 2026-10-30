#!/usr/bin/env node
/**
 * Record one eval-runner report in the model benchmark snapshot
 * (docs/specs/2026-10-30-model-comparison-page-design.md, "Internal eval
 * results").
 *
 *   pnpm --silent --filter @valet/eval start -- --cases evals/cases/hard \
 *     --model amazon-bedrock/deepseek.v3.2 --runs 3 --json > run.json
 *   node scripts/evals/snapshot-benchmarks.mjs --family deepseek-v3.2 \
 *     --model amazon-bedrock/deepseek.v3.2 --suite evals/cases/hard \
 *     [--reasoning high] [--date YYYY-MM-DD] [--file <snapshot.json>] < run.json
 *
 * Pass rate is passed runs over all runs of the non-skipped cases; mean
 * cost is per single run, averaged over priced cases. The family's
 * `valetEval` block is replaced and the file keeps its one-entry-per-line
 * layout. No dependencies.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/shared/src/model-benchmarks.json');

/**
 * Turn a runner `--json` report into a `ValetEvalResult`.
 * @param {{ entries: Array<{ status: string; costUsd?: number; sampling?: { runs?: number } }> }} report
 * @param {{ suite: string; modelSpec: string; reasoning?: string; date: string }} opts
 */
export function summarize(report, opts) {
  if (report === null || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.entries)) {
    throw new Error('Report must be the runner\'s --json output: an object with an `entries` array.');
  }
  const ran = report.entries.filter((e) => e.status === 'pass' || e.status === 'fail');
  if (ran.length === 0) throw new Error('No cases ran (every entry skipped or the report is empty).');
  // With pass@k sampling, `sampling.runs`/`passes` are per run and `costUsd`
  // is the total across ALL runs (ScorecardEntry); without it, one run each.
  const runsOf = (e) => Math.max(1, e.sampling?.runs ?? 1);
  const passesOf = (e) => (e.sampling ? (e.sampling.passes ?? 0) : e.status === 'pass' ? 1 : 0);
  const totalRuns = ran.reduce((a, e) => a + runsOf(e), 0);
  const totalPasses = ran.reduce((a, e) => a + passesOf(e), 0);
  const priced = ran.filter((e) => typeof e.costUsd === 'number' && Number.isFinite(e.costUsd));
  const result = {
    suite: opts.suite,
    modelSpec: opts.modelSpec,
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    cases: ran.length,
    runsPerCase: Math.max(...ran.map(runsOf)),
    passRate: Math.round((100 * totalPasses) / totalRuns),
    ...(priced.length > 0
      ? { meanCostUsd: round4(priced.reduce((a, e) => a + e.costUsd / runsOf(e), 0) / priced.length) }
      : {}),
    ranAt: opts.date,
  };
  return result;
}

/** The snapshot as text: scalar fields pretty, one compact entry per line,
 * so recording a run is a one-line diff. */
export function formatSnapshot(snapshot) {
  const { entries, ...rest } = snapshot;
  const head = Object.entries(rest).map(([k, v]) => `  ${JSON.stringify(k)}: ${compactJson(v)},`);
  const body = entries.map((e, i) => `    ${compactJson(e)}${i < entries.length - 1 ? ',' : ''}`);
  return ['{', ...head, '  "entries": [', ...body, '  ]', '}', ''].join('\n');
}

/** JSON with a space after `:` and `,` (Python's default separators), one line. */
function compactJson(value) {
  return JSON.stringify(value).replace(/"([^"\\]|\\.)*"|[:,]/g, (m) => (m === ':' ? ': ' : m === ',' ? ', ' : m));
}

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * A copy of `snapshot` with `family`'s `valetEval` replaced by `result`.
 * @template T
 * @param {{ entries: Array<{ family: string } & Record<string, unknown>> } & T} snapshot
 */
export function applyToSnapshot(snapshot, family, result) {
  const index = snapshot.entries.findIndex((e) => e.family === family);
  if (index === -1) {
    throw new Error(`Unknown family "${family}". Add it to the snapshot's entries first.`);
  }
  const entries = snapshot.entries.map((e, i) => (i === index ? { ...e, valetEval: result } : e));
  return { ...snapshot, entries };
}

function main() {
  const { values } = parseArgs({
    options: {
      family: { type: 'string' },
      model: { type: 'string' },
      suite: { type: 'string' },
      reasoning: { type: 'string' },
      date: { type: 'string' },
      file: { type: 'string', default: DEFAULT_FILE },
    },
  });
  for (const key of ['family', 'model', 'suite']) {
    if (!values[key]) {
      console.error(`--${key} is required`);
      process.exit(2);
    }
  }
  const report = JSON.parse(readFileSync(0, 'utf8'));
  const result = summarize(report, {
    suite: values.suite,
    modelSpec: values.model,
    reasoning: values.reasoning,
    date: values.date ?? new Date().toISOString().slice(0, 10),
  });
  const snapshot = JSON.parse(readFileSync(values.file, 'utf8'));
  const next = applyToSnapshot(snapshot, values.family, result);
  writeFileSync(values.file, formatSnapshot(next));
  console.log(`${values.family}: ${result.passRate}% over ${result.cases} cases → ${values.file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
