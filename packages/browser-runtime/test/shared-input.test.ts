import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserDaemon, type BrowserBackend } from '../src/daemon.js';
import type { BrowserHumanInput, BrowserTabInfo } from '@valet/shared';

const identity = {
  protocolVersion: '1.0' as const,
  sessionId: 's',
  threadId: 't',
  actorId: 'person',
  ownerId: 'person',
  audience: 'viewer' as const,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'browser-shared-'));
  const order: string[] = [];
  const tab: BrowserTabInfo = {
    id: 'tab',
    runtimeId: '',
    documentId: 'doc',
    url: 'about:blank',
    title: '',
    ownerThreadId: 't',
    actorId: 'person',
    mark: 'user',
  };
  const backend: BrowserBackend = {
    capabilities: {},
    start: async () => {},
    close: async () => {},
    tabs: () => [tab],
    invalidate: () => {},
    setPrivate: () => {},
    policyState: async () => ({ origin: 'about:blank' }),
    execute: async (method) => {
      order.push(method);
      return tab;
    },
    turnEnd: async () => {},
    info: () => tab,
    newTab: async () => {
      order.push('new');
      return tab;
    },
    select: () => {
      order.push('select');
    },
    frame: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    viewport: async () => ({
      width: 100,
      height: 80,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
    }),
    humanInput: async (_id, _document, input) => {
      order.push(`human:${input.type}`);
    },
    releaseInput: async () => {
      order.push('releaseInput');
    },
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
    backendFactory: () => backend,
  });
  tab.runtimeId = daemon.runtimeId;
  await daemon.start();
  cleanups.push(async () => {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  });
  const input = (
    input: BrowserHumanInput,
    extra: Record<string, unknown> = {},
  ) =>
    daemon.handle({
      ...identity,
      command: 'input',
      runtimeId: daemon.runtimeId,
      tabId: tab.id,
      documentId: tab.documentId,
      input,
      ...extra,
    });
  const control = (extra: Record<string, unknown> = {}) =>
    daemon.handle({
      ...identity,
      command: 'control',
      action: 'take',
      ...extra,
    });
  return { daemon, backend, tab, order, input, control };
}

async function runAgent(f: Awaited<ReturnType<typeof fixture>>, code: string) {
  const agent = {
    ...identity,
    audience: 'agent',
    command: 'submit',
    invocationId: 'shared',
    code,
    title: 'Shared input test',
  };
  expect((await f.daemon.handle(agent)).ok).toBe(true);
  let cursor = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await f.daemon.handle({
      ...identity,
      audience: 'agent',
      command: 'events',
      invocationId: 'shared',
      waitMs: 500,
      after: cursor,
    });
    cursor = result.cursor;
    for (const event of result.events) {
      if (event.type !== 'approval') continue;
      const request = event.request;
      expect(
        (
          await f.daemon.handle({
            ...identity,
            audience: 'agent',
            command: 'resolve',
            invocationId: 'shared',
            operationId: request.operationId,
            runtimeId: request.runtimeId,
            hash: request.hash,
            decision: 'allow',
            policyVersion: request.policyVersion,
            expiresAt: request.expiresAt,
          })
        ).ok,
      ).toBe(true);
    }
    if (result.cell?.status === 'completed' || result.cell?.status === 'failed')
      return result.cell;
  }
  throw Error('Browser cell did not settle.');
}

it('allows shared tab and keyboard effects followed by an agent mutation without taking or releasing control', async () => {
  const f = await fixture();
  expect(
    (
      await f.daemon.handle({
        ...identity,
        command: 'tab',
        action: 'new',
        runtimeId: f.daemon.runtimeId,
      })
    ).ok,
  ).toBe(true);
  expect((await f.input({ type: 'key', key: 'Shift', phase: 'down' })).ok).toBe(
    true,
  );
  expect(f.daemon.status().control).toBeNull();
  expect((await runAgent(f, 'await browser.tabs.new()')).status).toBe(
    'completed',
  );
  expect(f.order).toEqual(['new', 'human:key', 'releaseInput', 'tabs.new']);
  expect(f.daemon.status().control).toBeNull();
});

it('rechecks agent policy after held-input cleanup changes the page', async () => {
  const f = await fixture();
  let documentId = 'original';
  f.backend.policyState = async () => ({ origin: 'about:blank', documentId });
  f.backend.releaseInput = async () => {
    documentId = 'after-keyup';
  };
  const result = await runAgent(f, 'await browser.tabs.new()');
  expect(result.status).toBe('failed');
  expect(result.operations).toContainEqual(
    expect.objectContaining({
      error: expect.objectContaining({ code: 'APPROVAL_STALE' }),
    }),
  );
  expect(f.order).toEqual([]);
});

it('does not let agent dialog responses bypass an explicit non-private pause', async () => {
  const f = await fixture();
  expect((await f.control()).ok).toBe(true);
  const result = await runAgent(
    f,
    "var page = await browser.tabs.get('tab'); await page.dialog.respond('dialog', true)",
  );
  expect(result.status).toBe('failed');
  expect(result.operations).toContainEqual(
    expect.objectContaining({
      error: expect.objectContaining({ code: 'CONTROL_HELD' }),
    }),
  );
  expect(f.order).not.toContain('tab.dialogRespond');
});

it('checks runtime, explicit lease ownership, and private isolation before shared input', async () => {
  const f = await fixture();
  expect(
    (await f.input({ type: 'key', key: 'x' }, { runtimeId: 'old' })).error
      ?.code,
  ).toBe('RUNTIME_CHANGED');
  expect(
    (await f.input({ type: 'key', key: 'x' }, { leaseId: 'forged' })).error
      ?.code,
  ).toBe('CONTROL_HELD');
  const taken = await f.control({ privateMode: true });
  const leaseId = taken.status?.control?.id;
  expect(leaseId).toBeTruthy();
  expect((await f.input({ type: 'key', key: 'x' })).error?.code).toBe(
    'CONTROL_HELD',
  );
  expect(
    (await f.input({ type: 'key', key: 'x' }, { leaseId, actorId: 'other' }))
      .error?.code,
  ).toBe('CONTROL_HELD');
  expect((await f.input({ type: 'key', key: 'x' }, { leaseId })).ok).toBe(true);
  expect(
    (
      await f.daemon.handle({
        ...identity,
        audience: 'agent',
        command: 'status',
      })
    ).status?.tabs,
  ).toEqual([]);
  expect((await f.control({ action: 'release', leaseId })).ok).toBe(true);
  expect((await f.input({ type: 'key', key: 'x' })).ok).toBe(true);
});

it('validates exclusive lease ownership before releasing held input', async () => {
  const f = await fixture();
  const taken = await f.control();
  const leaseId = taken.status?.control?.id;
  expect(
    (await f.input({ type: 'key', key: 'Shift', phase: 'down' }, { leaseId }))
      .ok,
  ).toBe(true);
  const before = [...f.order];
  for (const action of ['release', 'pause'])
    expect(
      (await f.control({ action, leaseId, actorId: 'other' })).error?.code,
    ).toBe('CONTROL_HELD');
  expect(f.order).toEqual(before);
});

it('orders shared inputs and rechecks queued admission when an explicit takeover starts', async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const humanInput = vi
    .spyOn(f.backend, 'humanInput')
    .mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
    });
  const first = f.input({ type: 'key', key: 'x' });
  await started.promise;
  const second = f.input({ type: 'key', key: 'y' });
  const taking = f.control();
  expect((await f.input({ type: 'key', key: 'z' })).error?.code).toBe(
    'CONTROL_HELD',
  );
  finish.resolve();
  expect((await first).ok).toBe(true);
  expect((await second).error?.code).toBe('CONTROL_HELD');
  expect((await taking).ok).toBe(true);
  expect(humanInput).toHaveBeenCalledTimes(1);
});

it('answers an open dialog while takeover waits for the effect that opened it', async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const dismissed = Promise.withResolvers<void>();
  f.backend.humanInput = async (_id, _document, input) => {
    if (input.type === 'dialog') dismissed.resolve();
    else {
      started.resolve();
      await dismissed.promise;
    }
  };
  const effect = f.input({ type: 'click', x: 1, y: 1 });
  await started.promise;
  const taking = f.control();
  expect(
    (
      await f.input(
        { type: 'dialog', dialogId: 'dialog', accept: true },
        { actorId: 'other' },
      )
    ).error?.code,
  ).toBe('CONTROL_HELD');
  expect(
    (await f.input({ type: 'dialog', dialogId: 'dialog', accept: true })).ok,
  ).toBe(true);
  expect((await effect).ok).toBe(true);
  expect((await taking).status?.control?.actorId).toBe('person');
});

it('returns pointer feedback separately from the event journal cursor', async () => {
  const f = await fixture();
  f.backend.humanInput = async () => 'pointer';
  const response = await f.input({ type: 'pointer', phase: 'move', x: 10, y: 10 });
  expect(response.ok).toBe(true);
  expect(response.pointerCursor).toBe('pointer');
  expect(typeof response.cursor).toBe('number');
});
