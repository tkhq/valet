import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserDaemon } from '../src/daemon.js';
import type { BrowserRequest, BrowserTabInfo } from '@valet/shared';
const identity = {
  protocolVersion: '1.0' as const,
  sessionId: 's',
  threadId: 't',
  actorId: 'a',
  ownerId: 'a',
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it('reports an unexpected Chromium exit as a crashed runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-daemon-crash-'));
  let crash: (() => void) | undefined;
  const daemon = new BrowserDaemon({
    stateDirectory: dir,
    workingDirectory: dir,
    sessionId: 's',
    repl: {
      testOnlyUnconfined: true,
      childPath: new URL('../src/repl/child.ts', import.meta.url),
      execArgv: ['--import', 'tsx'],
    },
    backendFactory: (options) => {
      crash = options.onCrash;
      return {
        capabilities: {},
        start: async () => {},
        close: async () => {},
        tabs: () => [],
        invalidate: () => {},
        setPrivate: () => {},
        policyState: async () => ({ origin: 'about:blank' }),
        execute: async () => undefined,
        turnEnd: async () => {},
        info: () => {
          throw Error('no tab');
        },
        newTab: async () => {
          throw Error('unused');
        },
        select: () => {},
        frame: async () => Buffer.from(''),
        viewport: async () => ({
          width: 1,
          height: 1,
          deviceScaleFactor: 1,
          scrollX: 0,
          scrollY: 0,
        }),
        humanInput: async () => {},
      };
    },
  });
  await daemon.start();
  cleanup.push(async () => {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  });

  expect(crash).toBeTypeOf('function');
  crash?.();
  const status = (await daemon.handle({ ...identity, command: 'status' })).status;
  expect(status?.state).toBe('crashed');
  expect(status?.correctiveAction).toBe(
    'Restart the browser. Your coding session stays open.',
  );
});

it('pauses nested browser effects for policy and attaches a repeated invocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-daemon-'));
  let effects = 0;
  let cleanupCount = 0;
  const tab: BrowserTabInfo = {
    id: 'tab',
    runtimeId: 'runtime',
    documentId: 'doc',
    url: 'https://private.example',
    title: 'Private title',
    ownerThreadId: 't',
    actorId: 'a',
    mark: 'temporary',
  };
  const daemon = new BrowserDaemon({
    stateDirectory: dir,
    workingDirectory: dir,
    sessionId: 's',
    repl: {
      testOnlyUnconfined: true,
      childPath: new URL('../src/repl/child.ts', import.meta.url),
      execArgv: ['--import', 'tsx'],
    },
    backendFactory: () => ({
      capabilities: {},
      start: async () => {},
      close: async () => {},
      tabs: () => [tab],
      invalidate: () => {},
      setPrivate: () => {},
      policyState: async () => ({ origin: 'about:blank' }),
      execute: async () => {
        effects++;
        return [];
      },
      turnEnd: async () => {
        cleanupCount++;
      },
      info: () => {
        throw Error('no tab');
      },
      newTab: async () => {
        throw Error('unused');
      },
      select: () => {},
      frame: async () => Buffer.from(''),
      viewport: async () => ({
        width: 1,
        height: 1,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
      }),
      humanInput: async () => {},
    }),
  });
  await daemon.start();
  cleanup.push(async () => {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request: BrowserRequest = {
    ...identity,
    command: 'submit',
    invocationId: 'call',
    code: 'await browser.tabs.list()',
    title: 'List',
  };
  const first = await daemon.handle(request);
  expect(first.ok).toBe(true);
  let batch = await daemon.handle({
    ...identity,
    command: 'events',
    invocationId: 'call',
    waitMs: 1000,
  });
  let approval = batch.events.find((e) => e.type === 'approval');
  const approvalDeadline = Date.now() + 5000;
  while (
    !approval &&
    Date.now() < approvalDeadline &&
    batch.cell?.status === 'running'
  ) {
    batch = await daemon.handle({
      ...identity,
      command: 'events',
      invocationId: 'call',
      after: batch.cursor,
      waitMs: 500,
    });
    approval = batch.events.find((event) => event.type === 'approval');
  }
  expect(approval?.type).toBe('approval');
  expect(effects).toBe(0);
  if (approval?.type !== 'approval') throw Error('Missing approval');
  const req = approval.request;
  await daemon.handle({
    ...identity,
    command: 'resolve',
    invocationId: 'call',
    operationId: req.operationId,
    hash: req.hash,
    runtimeId: req.runtimeId,
    decision: 'allow',
    policyVersion: req.policyVersion,
    expiresAt: req.expiresAt,
  });
  for (let count = 0; count < 5; count++) {
    batch = await daemon.handle({
      ...identity,
      command: 'events',
      invocationId: 'call',
      after: batch.cursor,
      waitMs: 1000,
    });
    if (batch.cell?.status === 'completed') break;
  }
  expect(batch.cell?.status).toBe('completed');
  expect(effects).toBe(1);
  const duplicate = await daemon.handle(request);
  expect(duplicate.cell?.cellId).toBe(first.cell?.cellId);
  expect(effects).toBe(1);
  const control = await daemon.handle({
    ...identity,
    audience: 'viewer',
    command: 'control',
    action: 'take',
    privateMode: true,
  });
  expect(control.status?.tabs[0]?.title).toBe('Private title');
  expect(
    (await daemon.handle({ ...identity, command: 'status' })).status?.tabs,
  ).toEqual([]);
  expect(
    (
      await daemon.handle({
        ...identity,
        audience: 'viewer',
        actorId: 'other',
        command: 'status',
      })
    ).status?.tabs,
  ).toEqual([]);
  expect(
    (
      await daemon.handle({
        ...identity,
        command: 'frame',
        runtimeId: daemon.runtimeId,
        tabId: 'tab',
      })
    ).error?.code,
  ).toBe('CONTROL_HELD');
  await daemon.handle({
    ...identity,
    audience: 'lifecycle',
    command: 'turn_end',
  });
  expect(cleanupCount).toBe(0);
  await daemon.handle({
    ...identity,
    audience: 'viewer',
    command: 'control',
    action: 'release',
    leaseId: control.status?.control?.id,
  });
  expect(cleanupCount).toBe(1);
  const forged = await daemon.handle({ ...request, actorId: 'other' });
  expect(forged.ok).toBe(false);
});
