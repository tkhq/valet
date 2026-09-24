import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.js';
const dirs: string[] = [];
const make = () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-journal-'));
  dirs.push(dir);
  return join(dir, 'journal.db');
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe('durable browser receipts', () => {
  it('attaches identical invocation without resubmission and rejects changed source', () => {
    const j = new Journal(make(), 'runtime:1');
    const first = j.submit(
      'session:1',
      'thread:1',
      'actor:1',
      'call:1',
      'hash:1',
    );
    expect(
      j.submit('session:1', 'thread:1', 'actor:1', 'call:1', 'hash:1'),
    ).toEqual({ created: false, cell: first.cell });
    expect(() =>
      j.submit('session:1', 'thread:1', 'actor:1', 'call:1', 'hash:2'),
    ).toThrow(/different/);
    expect(() =>
      j.submit('session:1', 'thread:2', 'actor:1', 'call:1', 'hash:1'),
    ).toThrow();
    j.close();
  });
  it('marks interrupted effects uncertain and lost cells on daemon restart', () => {
    const path = make();
    let j = new Journal(path, 'runtime:1');
    const { cell } = j.submit('s', 't', 'a', 'i', 'h');
    j.prepare(cell.cellId, 'op:1', 'tab.click', 'hash');
    j.operation('op:1', 'in_flight');
    j.close();
    j = new Journal(path, 'runtime:2');
    const receipt = j.cell('i', 's', 't', 'a');
    expect(receipt?.status).toBe('lost');
    expect(receipt?.operations[0].status).toBe('outcome_unknown');
    expect(j.submit('s', 't', 'a', 'i', 'h').created).toBe(false);
    j.close();
  });
  it('returns bounded event batches with a gap marker after retention', () => {
    const j = new Journal(make(), 'r', 3);
    for (let i = 0; i < 5; i++)
      j.emit({ type: 'text', text: String(i) }, 'cell');
    const result = j.events('cell', 1);
    expect(result.gap).toBe(true);
    expect(result.events.map((e) => e.type === 'text' && e.text)).toEqual([
      '2',
      '3',
      '4',
    ]);
    j.close();
  });
});
it('bounds aggregate receipt results while retaining explicit truncation metadata', () => {
  const j = new Journal(make(), 'r');
  const { cell } = j.submit('s', 't', 'a', 'i', 'h');
  for (let index = 0; index < 10; index++) {
    const id = `op:${index}`;
    j.prepare(cell.cellId, id, 'tab.getAXState', id);
    j.operation(id, 'completed', 'x'.repeat(20000));
  }
  const receipt = j.byId(cell.cellId);
  expect(JSON.stringify(receipt).length).toBeLessThan(64000);
  expect(
    receipt.operations.some((operation) => operation.resultTruncated),
  ).toBe(true);
  j.close();
});
