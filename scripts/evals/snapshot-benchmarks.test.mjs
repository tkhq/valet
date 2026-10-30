import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToSnapshot, summarize } from './snapshot-benchmarks.mjs';

const OPTS = { family: 'deepseek-v3.2', modelSpec: 'amazon-bedrock/deepseek.v3.2', suite: 'evals/cases/hard', reasoning: 'high', date: '2026-10-30' };

test('summarize counts run cases, excludes skips, and averages priced cost', () => {
  const report = {
    entries: [
      { caseId: 'a', status: 'pass', durationMs: 1, costUsd: 0.1, checkResults: [] },
      { caseId: 'b', status: 'fail', durationMs: 1, costUsd: 0.3, checkResults: [] },
      { caseId: 'c', status: 'skip', durationMs: 0, skipReason: 'no key', checkResults: [] },
      { caseId: 'd', status: 'pass', durationMs: 1, checkResults: [] },
    ],
  };
  assert.deepEqual(summarize(report, OPTS), {
    suite: 'evals/cases/hard',
    modelSpec: 'amazon-bedrock/deepseek.v3.2',
    reasoning: 'high',
    cases: 3,
    runsPerCase: 1,
    passRate: 67,
    meanCostUsd: 0.2,
    ranAt: '2026-10-30',
  });
});

test('summarize uses per-run passes and per-run cost when sampling is present', () => {
  // costUsd is the total across ALL runs (ScorecardEntry); passRate is the
  // share of runs that passed, not the thresholded case status.
  const report = {
    entries: [
      { caseId: 'a', status: 'pass', durationMs: 1, costUsd: 0.3, checkResults: [], sampling: { runs: 3, passes: 3 } },
      { caseId: 'b', status: 'pass', durationMs: 1, costUsd: 0.6, checkResults: [], sampling: { runs: 3, passes: 2 } },
    ],
  };
  const out = summarize(report, { ...OPTS, reasoning: undefined });
  assert.equal(out.runsPerCase, 3);
  assert.equal(out.passRate, 83); // 5 of 6 runs
  assert.equal(out.meanCostUsd, 0.15); // (0.3/3 + 0.6/3) / 2
  assert.equal('reasoning' in out, false);
});

test('summarize omits cost when nothing is priced', () => {
  const out = summarize({ entries: [{ caseId: 'a', status: 'pass', durationMs: 1, checkResults: [] }] }, OPTS);
  assert.equal('meanCostUsd' in out, false);
});

test('summarize rejects a report that is not an object with an entries array', () => {
  assert.throws(() => summarize(null, OPTS), /entries/);
  assert.throws(() => summarize([], OPTS), /entries/);
  assert.throws(() => summarize({ entries: 'x' }, OPTS), /entries/);
});

test('formatSnapshot keeps one entry per line so a refresh is a one-line diff', async () => {
  const { formatSnapshot } = await import('./snapshot-benchmarks.mjs');
  const text = formatSnapshot({ asOf: '2026-10-30', source: { label: 'x', url: 'y', version: 'z' }, entries: [{ family: 'a', name: 'a', ids: ['a'] }, { family: 'b', name: 'b', ids: ['b'] }] });
  const lines = text.split('\n');
  assert.equal(lines[0], '{');
  assert.equal(lines[1], '  "asOf": "2026-10-30",');
  assert.equal(lines[2], '  "source": {"label": "x", "url": "y", "version": "z"},');
  assert.equal(lines[3], '  "entries": [');
  assert.equal(lines[4], '    {"family": "a", "name": "a", "ids": ["a"]},');
  assert.equal(lines[5], '    {"family": "b", "name": "b", "ids": ["b"]}');
  assert.equal(lines[6], '  ]');
  assert.equal(lines[7], '}');
  assert.equal(lines[8], '');
  assert.equal(JSON.stringify(JSON.parse(text).entries.length), '2');
});

test('summarize refuses a report where no case ran', () => {
  assert.throws(() => summarize({ entries: [{ caseId: 'a', status: 'skip', durationMs: 0, checkResults: [] }] }, OPTS), /No cases ran/);
  assert.throws(() => summarize({ entries: [] }, OPTS), /No cases ran/);
});

test('applyToSnapshot replaces the family block, keeps other fields, and rejects unknown families', () => {
  const snapshot = {
    asOf: '2026-10-30',
    source: { label: 'x', url: 'y', version: 'z' },
    entries: [
      { family: 'deepseek-v3.2', name: 'DeepSeek V3.2', ids: ['deepseek.v3.2'], intelligenceIndex: 42, indexVersion: 'v4.0', valetEval: { suite: 'old', modelSpec: 'm', cases: 1, runsPerCase: 1, passRate: 10, ranAt: '2026-01-01' } },
      { family: 'other', name: 'Other', ids: ['other'] },
    ],
  };
  const result = summarize({ entries: [{ caseId: 'a', status: 'pass', durationMs: 1, checkResults: [] }] }, OPTS);
  const next = applyToSnapshot(snapshot, 'deepseek-v3.2', result);
  assert.equal(next.entries[0].valetEval.passRate, 100);
  assert.equal(next.entries[0].valetEval.suite, 'evals/cases/hard');
  assert.equal(next.entries[0].intelligenceIndex, 42);
  assert.deepEqual(next.entries[1], snapshot.entries[1]);
  assert.equal(snapshot.entries[0].valetEval.passRate, 10, 'input is not mutated');
  assert.throws(() => applyToSnapshot(snapshot, 'nope', result), /Unknown family/);
});
