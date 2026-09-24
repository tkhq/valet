import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserLocator, BrowserTabInfo } from '@valet/shared';
import { PlaywrightBackend } from '../src/browser.js';
import { FileBroker } from '../src/files.js';
import { AgentCursorTracker } from '../src/agent-cursor.js';

const installed = existsSync(chromium.executablePath());
if (!installed && process.env.VALET_BROWSER_REQUIRE_REAL === '1')
  throw Error('Pinned Chromium is missing. Run playwright-core install chromium.');

describe.skipIf(!installed)('agent cursor in Chromium', () => {
  let backend: PlaywrightBackend;
  let dir: string;
  let origin: string;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/child') {
      res.end('<style>button{position:absolute;left:20px;top:30px;width:100px;height:40px}input{position:absolute;left:20px;top:100px;width:140px;height:30px;box-sizing:border-box}</style><button>Frame button</button><input aria-label="Frame input">');
      return;
    }
    res.end(`<style>*{box-sizing:border-box}button{position:absolute;left:100px;top:60px;width:120px;height:40px}input[type=text]{position:absolute;left:100px;top:130px;width:200px;height:40px}input[type=checkbox]{position:absolute;left:100px;top:190px;width:30px;height:30px;margin:0}iframe{position:absolute;left:400px;top:200px;width:316px;height:216px;border:8px solid;transform:scale(.75);transform-origin:top left}</style><button onclick="document.querySelector('output').hidden=false">Save</button><input type=text aria-label="Name"><input type=checkbox aria-label="Ready"><output hidden>Revealed</output><iframe src="${origin.replace('127.0.0.1', 'localhost')}/child"></iframe>`);
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture address');
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'agent-cursor-'));
    const files = new FileBroker(join(dir, 'files'), 's', 'r', dir);
    await files.initialize();
    backend = new PlaywrightBackend({ runtimeId: 'r', profile: join(dir, 'profile'), files, testOnlyUnconfined: true });
    await backend.start();
  });
  afterAll(async () => {
    await backend?.close();
    server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    backend.setPrivate(false);
    for (const tab of backend.tabs())
      await backend.execute('tab.close', { tabId: tab.id, runtimeId: 'r' }, 'thread', 'actor');
  });
  async function loadedTab() {
    const tab = await backend.newTab('thread', 'actor', origin);
    await backend.execute('tab.waitForLoadState', { tabId: tab.id, runtimeId: 'r', state: 'load' }, 'thread', 'actor');
    return backend.info(tab.id);
  }
  function locator(tab: BrowserTabInfo, steps: BrowserLocator['steps'], action: string, args: unknown[] = []) {
    return backend.execute(`locator.${action}`, { locator: { tabId: tab.id, runtimeId: 'r', steps }, args }, 'thread', 'actor');
  }
  const save: BrowserLocator['steps'] = [{ kind: 'role', value: 'button', name: 'Save', exact: true }];
  const name: BrowserLocator['steps'] = [{ kind: 'label', value: 'Name', exact: true }];

  it('tracks locator clicks, editable fill and typing without retaining text', async () => {
    const tab = await loadedTab();
    await locator(tab, save, 'click');
    await expect.poll(() => backend.agentCursor(tab.id)).toMatchObject({ x: 160, y: 80, kind: 'click' });
    const click = backend.agentCursor(tab.id)!;
    await locator(tab, name, 'fill', ['secret text']);
    await expect.poll(() => backend.agentCursor(tab.id)).toMatchObject({ x: 200, y: 150, kind: 'type' });
    const fill = backend.agentCursor(tab.id)!;
    expect(fill.sequence).toBeGreaterThan(click.sequence);
    await locator(tab, name, 'type', ['more text']);
    await expect.poll(() => backend.agentCursor(tab.id)?.sequence).toBeGreaterThan(fill.sequence);
    expect(Object.keys(backend.agentCursor(tab.id)!).sort()).toEqual(['ageMs', 'kind', 'sequence', 'x', 'y']);
    await locator(tab, [{ kind: 'label', value: 'Ready', exact: true }], 'check');
    await expect.poll(() => backend.agentCursor(tab.id)).toMatchObject({ x: 115, y: 205, kind: 'click' });
  });

  it('tracks coordinate clicks and movement using viewport pixels', async () => {
    const tab = await loadedTab();
    await backend.observe(tab.id, 'thread');
    await backend.execute('tab.click', { tabId: tab.id, runtimeId: 'r', args: [{ x: 150, y: 75 }] }, 'thread', 'actor');
    await expect.poll(() => backend.agentCursor(tab.id)).toMatchObject({ x: 150, y: 75, kind: 'click' });
    await backend.execute('tab.hover', { tabId: tab.id, runtimeId: 'r', args: [{ x: 320, y: 180 }] }, 'thread', 'actor');
    await expect.poll(() => backend.agentCursor(tab.id)).toMatchObject({ x: 320, y: 180, kind: 'move' });
  });

  it('maps cross-origin child frame events through borders and scale', async () => {
    const tab = await loadedTab();
    await locator(tab, [{ kind: 'frame', value: 'iframe' }, { kind: 'role', value: 'button', name: 'Frame button', exact: true }], 'click');
    // Playwright uses an unscaled locator box for out-of-process frames.
    await expect.poll(() => backend.agentCursor(tab.id)?.kind).toBe('click');
    expect(backend.agentCursor(tab.id)!.x).toBeCloseTo(470);
    expect(backend.agentCursor(tab.id)!.y).toBeCloseTo(250);
    await backend.observe(tab.id, 'thread');
    await backend.execute('tab.click', { tabId: tab.id, runtimeId: 'r', args: [{ x: 458.5, y: 243.5 }] }, 'thread', 'actor');
    await expect.poll(() => backend.agentCursor(tab.id)).toMatchObject({ x: 458.5, y: 243.5, kind: 'click' });
    await locator(tab, [{ kind: 'frame', value: 'iframe' }, { kind: 'label', value: 'Frame input', exact: true }], 'fill', ['frame text']);
    await expect.poll(() => backend.agentCursor(tab.id)).toMatchObject({ x: 473.5, y: 292.25, kind: 'type' });
  });

  it('clears on human input and does not classify overlapping observations as agent input', async () => {
    const tab = await loadedTab();
    await locator(tab, name, 'fill', ['agent']);
    await expect.poll(() => backend.agentCursor(tab.id)?.kind).toBe('type');
    const observation = locator(tab, [{ kind: 'text', value: 'Revealed', exact: true }], 'waitFor');
    await backend.humanInput(tab.id, tab.documentId, { type: 'click', x: 160, y: 80 });
    await observation;
    expect(backend.agentCursor(tab.id)).toBeUndefined();
    await backend.humanInput(tab.id, tab.documentId, { type: 'click', x: 150, y: 150 });
    await backend.humanInput(tab.id, tab.documentId, { type: 'text', text: 'human text' });
    expect(backend.agentCursor(tab.id)).toBeUndefined();
  });

  it('clears on navigation and private transitions, and expires after 2500 ms', async () => {
    const tab = await loadedTab();
    await locator(tab, save, 'click');
    await expect.poll(() => backend.agentCursor(tab.id)?.kind).toBe('click');
    const first = backend.agentCursor(tab.id)!;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2500);
    expect(backend.agentCursor(tab.id)).toBeUndefined();
    vi.restoreAllMocks();
    await locator(tab, name, 'fill', ['next']);
    await expect.poll(() => backend.agentCursor(tab.id)?.kind).toBe('type');
    expect(backend.agentCursor(tab.id)!.sequence).toBeGreaterThan(first.sequence);
    backend.setPrivate(true);
    expect(backend.agentCursor(tab.id)).toBeUndefined();
    await locator(tab, save, 'click');
    backend.setPrivate(false);
    expect(backend.agentCursor(tab.id)).toBeUndefined();
    await locator(tab, name, 'fill', ['after private']);
    await expect.poll(() => backend.agentCursor(tab.id)?.kind).toBe('type');
    await backend.execute('tab.reload', { tabId: tab.id, runtimeId: 'r' }, 'thread', 'actor');
    expect(backend.agentCursor(tab.id)).toBeUndefined();
  });

  it('contains mapping failures and rejects callbacks after clearing or human overlap', async () => {
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const context = await browser.newContext();
      const tracker = new AgentCursorTracker();
      await tracker.install(context);
      const page = await context.newPage();
      await page.goto('data:text/html,<button>Save</button>');
      const frame = page.mainFrame();
      const evaluate = frame.evaluate.bind(frame);
      let releaseMapping: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => { releaseMapping = resolve; });
      const mapping = vi.spyOn(frame, 'evaluate').mockImplementation(async (fn, arg) => {
        await blocked;
        return evaluate(fn, arg);
      });
      const end = tracker.begin(page);
      await page.getByRole('button').click();
      end();
      await expect.poll(() => mapping.mock.calls.length).toBeGreaterThan(0);
      tracker.clear(page);
      releaseMapping?.();
      await expect.poll(() => mapping.mock.settledResults.every((result) => result.type !== 'incomplete')).toBe(true);
      expect(tracker.get(page)).toBeUndefined();
      mapping.mockRestore();
      const resume = tracker.suspend(page);
      const endDuringHuman = tracker.begin(page);
      await page.getByRole('button').click();
      endDuringHuman();
      resume();
      expect(tracker.get(page)).toBeUndefined();
      const failedMapping = vi.spyOn(frame, 'evaluate').mockRejectedValue(Error('Detached frame'));
      const endWithFailure = tracker.begin(page);
      await expect(page.getByRole('button').click()).resolves.toBeUndefined();
      endWithFailure();
      await expect.poll(() => failedMapping.mock.calls.length).toBeGreaterThan(0);
      expect(tracker.get(page)).toBeUndefined();
      failedMapping.mockRestore();
    } finally {
      await browser.close();
    }
  });

  it('preserves action results and errors when tracker setup or cleanup fails', async () => {
    const tab = await loadedTab();
    const begin = AgentCursorTracker.prototype.begin;
    const setupFailure = vi.spyOn(AgentCursorTracker.prototype, 'begin').mockImplementation(() => { throw Error('Tracker setup failed'); });
    await expect(locator(tab, name, 'fill', ['saved'])).resolves.toBeUndefined();
    setupFailure.mockRestore();
    const cleanupFailure = vi.spyOn(AgentCursorTracker.prototype, 'begin').mockImplementation(function (this: AgentCursorTracker, page) {
      const end = begin.call(this, page);
      return () => { end(); throw Error('Tracker cleanup failed'); };
    });
    await expect(locator(tab, name, 'fill', ['saved again'])).resolves.toBeUndefined();
    await expect(locator(tab, [{ kind: 'label', value: 'Missing', exact: true }], 'fill', ['text'])).rejects.toThrow('The locator matches 0 elements.');
    cleanupFailure.mockRestore();
    const humanFailure = vi.spyOn(AgentCursorTracker.prototype, 'suspend').mockImplementation(() => { throw Error('Tracker human guard failed'); });
    await expect(backend.humanInput(tab.id, tab.documentId, { type: 'text', text: ' human' })).resolves.toBeUndefined();
    humanFailure.mockRestore();
  });

  it('ignores synthetic events and invalid display telemetry', async () => {
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const context = await browser.newContext();
      const tracker = new AgentCursorTracker();
      await tracker.install(context);
      const page = await context.newPage();
      await page.goto('data:text/html,<button>Save</button>');
      const end = tracker.begin(page);
      await page.evaluate(async () => {
        document.querySelector('button')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
        const name = Object.getOwnPropertyNames(globalThis).find((key) => key.startsWith('__valetCursor_'));
        const send: unknown = name ? Reflect.get(globalThis, name) : undefined;
        if (typeof send !== 'function') throw Error('Cursor telemetry is not installed');
        const base = { x: 20, y: 20, kind: 'click', document: performance.timeOrigin,
          timestamp: performance.timeOrigin + performance.now() };
        for (const payload of [null, {}, { ...base, x: NaN }, { ...base, y: Infinity },
          { ...base, x: '20' }, { ...base, kind: 'key' }, { ...base, timestamp: Infinity }])
          await send(payload);
      });
      end();
      expect(tracker.get(page)).toBeUndefined();
      const endReal = tracker.begin(page);
      await page.getByRole('button').click();
      endReal();
      await expect.poll(() => tracker.get(page)?.kind).toBe('click');
    } finally {
      await browser.close();
    }
  });
});
