import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserDaemon, type BrowserBackend } from '../src/daemon.js';
import { parseRequest } from '../src/protocol.js';
import type { BrowserTabInfo } from '@valet/shared';

const identity = {
  protocolVersion: '1.0' as const,
  sessionId: 's', threadId: 't', actorId: 'a', ownerId: 'a',
  audience: 'viewer' as const,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'browser-frames-'));
  const tab: BrowserTabInfo = {
    id: 'tab', runtimeId: '', documentId: 'doc', url: 'about:blank', title: '',
    ownerThreadId: 't', actorId: 'a', mark: 'user',
  };
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const backend: BrowserBackend = {
    capabilities: {}, start: async () => {}, close: async () => {}, tabs: () => [tab],
    invalidate: () => {}, setPrivate: () => {}, policyState: async () => ({ origin: 'about:blank' }),
    execute: async () => null, turnEnd: async () => {}, info: () => tab,
    newTab: async () => tab, select: () => {}, frame: async () => bytes,
    viewport: async () => ({ width: 100, height: 80, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 }),
    humanInput: async () => {},
  };
  const daemon = new BrowserDaemon({
    stateDirectory: dir, workingDirectory: dir, sessionId: 's',
    repl: { testOnlyUnconfined: true }, backendFactory: () => backend,
  });
  tab.runtimeId = daemon.runtimeId;
  await daemon.start();
  cleanups.push(async () => { await daemon.close(); await rm(dir, { recursive: true, force: true }); });
  const frame = () => daemon.handle({ ...identity, command: 'frame', inline: true, runtimeId: daemon.runtimeId, tabId: tab.id });
  return { daemon, backend, tab, frame, bytes, dir };
}

it('returns bounded JPEG bytes inline without creating a file transfer', async () => {
  const f = await fixture();
  const response = await f.frame();
  expect(response.ok).toBe(true);
  expect(response.frame).toEqual({
    mimeType: 'image/jpeg', data: f.bytes.toString('base64'), bytes: f.bytes.length,
    sha256: createHash('sha256').update(f.bytes).digest('hex'), tabId: 'tab', documentId: 'doc',
    viewport: { width: 100, height: 80 },
  });
  expect(response.artifact).toBeUndefined();
  expect(await readdir(join(f.dir, 'transfers'))).toEqual([]);
});

it('keeps the existing file transfer mode', async () => {
  const f = await fixture();
  const response = await f.daemon.handle({ ...identity, command: 'frame', runtimeId: f.daemon.runtimeId, tabId: f.tab.id });
  expect(response.ok).toBe(true);
  expect(response.artifact?.sha256).toBe(createHash('sha256').update(f.bytes).digest('hex'));
  expect(response.frame).toBeUndefined();
});

it('rejects inline JPEGs over 700000 bytes and releases the capture slot', async () => {
  const f = await fixture();
  f.backend.frame = async () => Buffer.alloc(700001);
  expect((await f.frame()).error?.code).toBe('QUOTA_EXCEEDED');
  f.backend.frame = async () => f.bytes;
  expect((await f.frame()).ok).toBe(true);
  expect(await readdir(join(f.dir, 'transfers'))).toEqual([]);
});

it.each(['frame', 'viewport'] as const)('rejects document changes during %s', async (phase) => {
  const f = await fixture();
  const original = f.backend[phase];
  if (phase === 'frame') f.backend.frame = async () => { f.tab.documentId = 'new'; return f.bytes; };
  else f.backend.viewport = async () => { f.tab.documentId = 'new'; return { width: 100, height: 80, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 }; };
  const response = await f.frame();
  expect(response.error?.code).toBe('STALE_REFERENCE');
  expect(response.frame).toBeUndefined();
  expect(original).toBeDefined();
});

it.each(['frame', 'viewport'] as const)('rejects private mode starting and ending during %s', async (phase) => {
  const f = await fixture();
  const transition = async () => {
    const take = await f.daemon.handle({ ...identity, command: 'control', action: 'take', privateMode: true });
    expect(take.ok).toBe(true);
    const release = await f.daemon.handle({ ...identity, command: 'control', action: 'release', leaseId: take.status?.control?.id });
    expect(release.ok).toBe(true);
  };
  if (phase === 'frame') f.backend.frame = async () => { await transition(); return f.bytes; };
  else f.backend.viewport = async () => { await transition(); return { width: 100, height: 80, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 }; };
  const response = await f.frame();
  expect(response.error?.code).toBe('CONTROL_HELD');
  expect(response.frame).toBeUndefined();
});

it('allows the private control owner to view and blocks other viewers', async () => {
  const f = await fixture();
  await f.daemon.handle({ ...identity, command: 'control', action: 'take', privateMode: true });
  expect((await f.frame()).frame?.data).toBe(f.bytes.toString('base64'));
  const response = await f.daemon.handle({ ...identity, actorId: 'other', command: 'frame', inline: true, runtimeId: f.daemon.runtimeId, tabId: 'tab' });
  expect(response.error?.code).toBe('CONTROL_HELD');
});

it('rejects a runtime replacement during viewport collection', async () => {
  const f = await fixture();
  f.backend.viewport = async () => { f.tab.runtimeId = 'replacement'; return { width: 100, height: 80, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 }; };
  expect((await f.frame()).error?.code).toBe('RUNTIME_CHANGED');
});

it('validates the optional inline frame flag', () => {
  expect(() => parseRequest({ ...identity, command: 'frame', tabId: 'tab', runtimeId: 'r', inline: 'yes' })).toThrow();
});
