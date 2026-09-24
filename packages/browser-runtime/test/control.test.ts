import { expect, it } from 'vitest';
import { Control } from '../src/control.js';
it('serializes effects and completes takeover after the current effect', async () => {
  const control = new Control('runtime');
  let release: (() => void) | undefined;
  const seen: string[] = [];
  const first = control.run('agent', async () => {
    seen.push('start');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    seen.push('end');
  });
  await Promise.resolve();
  const taking = control.take('person');
  release?.();
  await first;
  const lease = await taking;
  expect(seen).toEqual(['start', 'end']);
  await expect(control.run('agent', async () => undefined)).rejects.toThrow(
    /control/,
  );
  expect(() => control.validate(lease.id, 'other', 'runtime')).toThrow();
  control.release(lease.id, 'person');
  await control.run('agent', async () => {
    seen.push('new');
  });
  expect(seen.at(-1)).toBe('new');
});
