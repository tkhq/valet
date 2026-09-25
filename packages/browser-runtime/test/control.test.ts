import { expect, it, vi } from 'vitest';
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
it('keeps the first pending takeover owner when another person requests control', async () => {
  const control = new Control('runtime');
  let finish: (() => void) | undefined;
  const effect = control.run('agent', () => new Promise<void>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  const first = control.take('first');
  const second = control.take('second');
  const rejected = expect(second).rejects.toThrow(/control/);
  finish?.();
  await effect;
  const lease = await first;
  await rejected;
  expect(control.lease).toBe(lease);
  expect(lease.actorId).toBe('first');
});

it('clears an expired shared lease so agents and another viewer can continue', async () => {
  const now = 1_000_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  let invalidations = 0;
  const control = new Control('runtime', () => { invalidations += 1; });
  await control.take('alice');

  clock.mockReturnValue(now + 120_001);

  expect(control.lease).toBeNull();
  expect(invalidations).toBe(2);
  await expect(control.run('agent', async () => 'continued')).resolves.toBe('continued');
  await expect(control.take('bob')).resolves.toMatchObject({ actorId: 'bob' });
  clock.mockRestore();
});

it('keeps expired private control until its owner explicitly releases it', async () => {
  const now = 1_000_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const control = new Control('runtime');
  const lease = await control.take('alice', true);

  clock.mockReturnValue(now + 120_001);

  expect(control.lease).toBe(lease);
  await expect(control.run('agent', async () => undefined)).rejects.toThrow(/control/);
  await expect(control.take('bob')).rejects.toThrow(/control/);
  control.release(lease.id, 'alice');
  expect(control.lease).toBeNull();
  clock.mockRestore();
});
