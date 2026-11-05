import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBroker } from '../src/files.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { force: true, recursive: true });
});
it('exports only issued artifacts and validates uploads without following symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-files-'));
  dirs.push(dir);
  const working = join(dir, 'working');
  await mkdir(working);
  await writeFile(join(working, 'file.txt'), 'upload');
  await symlink(join(working, 'file.txt'), join(working, 'alias.txt'));
  const broker = new FileBroker(
    join(dir, 'private'),
    'session',
    'runtime',
    working,
  );
  await broker.initialize();
  const artifact = await broker.create(
    Buffer.from('pixels'),
    'image/png',
    '../../image.png',
  );
  const transfer = await broker.export(artifact.id);
  expect(transfer.filename).toBe('image.png');
  expect(transfer.bytes).toBe(6);
  expect(transfer.path).toContain('/transfers/');
  await expect(broker.export('forged')).rejects.toThrow();
  expect((await broker.upload(['file.txt']))[0].buffer.toString()).toBe(
    'upload',
  );
  await expect(broker.upload(['alias.txt'])).rejects.toThrow(/symlink/);
  await expect(broker.upload(['../private'])).rejects.toThrow();
});
it('retains at most two queued frames per viewer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-frames-'));
  dirs.push(dir);
  const broker = new FileBroker(dir, 's', 'r', dir);
  await broker.initialize();
  const first = await broker.frame(Buffer.from('one'), {}, 'viewer');
  await broker.frame(Buffer.from('two'), {}, 'viewer');
  await broker.frame(Buffer.from('three'), {}, 'viewer');
  const { stat } = await import('node:fs/promises');
  await expect(stat(first.path)).rejects.toThrow();
});
it('reserves artifact quota before concurrent writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-quota-'));
  dirs.push(dir);
  const broker = new FileBroker(dir, 's', 'r', dir, 50, 60);
  await broker.initialize();
  const results = await Promise.allSettled([
    broker.create(Buffer.alloc(40), 'text/plain', 'one.txt'),
    broker.create(Buffer.alloc(40), 'text/plain', 'two.txt'),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
});
