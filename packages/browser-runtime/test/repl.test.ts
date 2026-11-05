import { describe, expect, it } from 'vitest';
import { ReplProcess } from '../src/repl/process.js';
const make = () =>
  new ReplProcess(
    {
      testOnlyUnconfined: true,
      childPath: new URL('../src/repl/child.ts', import.meta.url),
      execArgv: ['--import', 'tsx'],
    },
    async (rpc) => (rpc.method === 'tabs.list' ? [] : undefined),
    () => {},
  );
describe('isolated cell process', () => {
  it('preserves bindings and supports top-level await', async () => {
    const repl = make();
    try {
      await repl.evaluate('cell1', 'let value = 40');
      expect(
        await repl.evaluate(
          'cell2',
          'value += await Promise.resolve(2); value',
        ),
      ).toBe(42);
      expect(await repl.evaluate('cell3', 'await browser.tabs.list()')).toEqual(
        [],
      );
    } finally {
      repl.close();
    }
  });
  it('settles syntax and asynchronous exceptions without hanging', async () => {
    const repl = make();
    try {
      await expect(
        repl.evaluate('cell1', 'throw new Error("fixture failure")'),
      ).rejects.toThrow(/fixture failure/);
      await expect(
        repl.evaluate(
          'cell2',
          'await Promise.reject(new Error("async failure"))',
        ),
      ).rejects.toThrow(/async failure/);
    } finally {
      repl.close();
    }
  });
  it('kills an infinite loop at its execution deadline', async () => {
    const repl = make();
    await expect(repl.evaluate('cell', 'while(true) {}', 500)).rejects.toThrow(
      /deadline/,
    );
    expect(repl.alive).toBe(false);
  });
  it('fails closed when no confinement launcher is supplied', () => {
    expect(
      () =>
        new ReplProcess(
          {},
          async () => undefined,
          () => {},
        ),
    ).toThrow(/confine/);
  });
});
it('reports lexical redeclaration and keeps earlier bindings available', async () => {
  const repl = make();
  try {
    await repl.evaluate('first', 'const stable = 7');
    await expect(repl.evaluate('second', 'const stable = 8')).rejects.toThrow(
      /already been declared/,
    );
    expect(await repl.evaluate('third', 'stable')).toBe(7);
  } finally {
    repl.close();
  }
});
