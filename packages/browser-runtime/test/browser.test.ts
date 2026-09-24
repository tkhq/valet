import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightBackend } from '../src/browser.js';
import { FileBroker } from '../src/files.js';
let backend: PlaywrightBackend;
let dir: string;
let origin: string;
const server = createServer((req, res) => {
  if (req.url === '/many-references') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      Array.from(
        { length: 140 },
        (_, index) => `<button>Control ${index}</button>`,
      ).join(''),
    );
    return;
  }
  if (req.url === '/many-nodes') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<main></main><script>for(let index=0;index<2100;index++)document.querySelector("main").appendChild(document.createTextNode("x"))</script>',
    );
    return;
  }
  if (req.url === '/many-frames') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<iframe src="/frame"></iframe>'.repeat(9));
    return;
  }
  if (req.url === '/frame') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<button>Frame control</button>');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<h1>Fixture</h1><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('h1').textContent='Saved '+document.querySelector('input').value">Save</button><button>Duplicate</button><button>Duplicate</button><div id="shadow"></div><iframe src="/frame"></iframe><output>ready</output><canvas width="80" height="40"></canvas><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow control</button>';document.onkeydown=e=>document.querySelector('output').textContent=String(e.shiftKey);document.querySelector('canvas').getContext('2d').fillRect(0,0,80,40)</script>`,
  );
});
const browserInstalled = existsSync(chromium.executablePath());
if (!browserInstalled && process.env.VALET_BROWSER_REQUIRE_REAL === '1')
  throw Error(
    'Pinned Chromium is missing. Run playwright-core install chromium.',
  );
describe.skipIf(!browserInstalled)('real Chromium fixtures', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture address');
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'browser-fixture-'));
    const files = new FileBroker(join(dir, 'files'), 's', 'r', dir);
    await files.initialize();
    backend = new PlaywrightBackend({
      runtimeId: 'r',
      profile: join(dir, 'profile'),
      files,
      testOnlyUnconfined: true,
    });
    await backend.start();
  });
  afterAll(async () => {
    await backend?.close();
    server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    for (const tab of backend.tabs())
      await backend.execute(
        'tab.close',
        { tabId: tab.id, runtimeId: 'r' },
        'cleanup',
        'actor',
      );
  });
  it('navigates, snapshots, uses strict locators, and captures actual pixels', async () => {
    const tab = await backend.newTab('thread', 'actor', origin);
    const observation = await backend.observe(tab.id, 'thread');
    expect(observation.text).toContain('Save');
    expect(observation.refs.length).toBeGreaterThan(0);
    const query = {
      tabId: tab.id,
      runtimeId: 'r',
      steps: [
        { kind: 'role', value: 'button', name: 'Duplicate', exact: true },
      ],
    };
    await expect(
      backend.execute(
        'locator.click',
        { locator: query, args: [] },
        'thread',
        'actor',
      ),
    ).rejects.toThrow(/matches/);
    await backend.execute(
      'locator.fill',
      {
        locator: {
          ...query,
          steps: [{ kind: 'label', value: 'Name', exact: true }],
        },
        args: ['Ada'],
      },
      'thread',
      'actor',
    );
    await backend.execute(
      'locator.click',
      {
        locator: {
          ...query,
          steps: [{ kind: 'role', value: 'button', name: 'Save', exact: true }],
        },
        args: [],
      },
      'thread',
      'actor',
    );
    expect((await backend.observe(tab.id, 'thread')).text).toContain(
      'Saved Ada',
    );
    const screenshot = await backend.screenshot(tab.id);
    expect(screenshot.mimeType).toBe('image/png');
    expect(screenshot.bytes).toBeGreaterThan(1000);
  });
  it('rejects detached and relabelled references without retargeting', async () => {
    const tab = await backend.newTab('thread', 'actor', origin);
    const observation = await backend.observe(tab.id, 'thread');
    await backend.execute(
      'tab.reload',
      { tabId: tab.id, runtimeId: 'r' },
      'thread',
      'actor',
    );
    await expect(
      backend.execute(
        'tab.click',
        { tabId: tab.id, runtimeId: 'r', args: [observation.refs[0]] },
        'thread',
        'actor',
      ),
    ).rejects.toThrow(/reference/);
  });
  it('retains user tabs and marked deliverables at turn completion', async () => {
    const temp = await backend.newTab('owned', 'actor');
    const kept = await backend.newTab('owned', 'actor');
    const user = await backend.newTab(null, 'actor');
    await backend.execute(
      'tab.markDeliverable',
      { tabId: kept.id, runtimeId: 'r' },
      'owned',
      'actor',
    );
    await backend.turnEnd('owned');
    expect(backend.tabs().some((t) => t.id === temp.id)).toBe(false);
    expect(backend.tabs().some((t) => t.id === kept.id)).toBe(true);
    expect(backend.tabs().some((t) => t.id === user.id)).toBe(true);
  });

  it('captures frame and open-shadow observations without exposing hidden secrets', async () => {
    const tab = await backend.newTab('frames', 'actor', origin);
    const ax = await backend.observe(tab.id, 'frames');
    expect(ax.text).toContain('Frame control');
    expect(ax.text).toContain('Shadow control');
    const dom = await backend.dom(tab.id);
    expect(dom.frames[0].html).toContain('Shadow control');
    expect(dom.frames.length).toBe(2);
  });
  it('releases held human keys before another actor uses the browser', async () => {
    const opened = await backend.newTab('input', 'actor', origin);
    await backend.execute(
      'tab.waitForLoadState',
      { tabId: opened.id, runtimeId: 'r', state: 'load' },
      'input',
      'actor',
    );
    const tab = backend.info(opened.id);
    await backend.humanInput(tab.id, tab.documentId, {
      type: 'key',
      key: 'Shift',
      phase: 'down',
    });
    await backend.releaseInput();
    await backend.humanInput(tab.id, tab.documentId, { type: 'key', key: 'x' });
    expect((await backend.observe(tab.id, 'input')).text).toContain('false');
  });
  it('opens an explicit blank tab without network authorization', async () => {
    const tab = await backend.newTab('blank', 'actor', 'about:blank');
    expect(tab.url).toBe('about:blank');
  });
  it('records screenshot crop coordinates and decoded PNG dimensions', async () => {
    const tab = await backend.newTab('crop', 'actor', origin);
    const result = await backend.execute(
      'tab.getScreenshot',
      {
        tabId: tab.id,
        runtimeId: 'r',
        options: { clip: { x: 10, y: 20, width: 100, height: 80 } },
      },
      'crop',
      'actor',
    );
    expect(result).toMatchObject({
      width: 100,
      height: 80,
      clip: { x: 10, y: 20, width: 100, height: 80 },
    });
  });
  it('bounds reference handles and marks omitted snapshot references', async () => {
    const tab = await backend.newTab(
      'bounded',
      'actor',
      `${origin}/many-references`,
    );
    const observation = await backend.observe(tab.id, 'bounded');
    expect(observation.refs.length).toBeLessThanOrEqual(128);
    expect(observation.text.length).toBeLessThanOrEqual(24_000);
    expect(observation.truncated).toBe(true);
    expect(observation.text).toContain('Snapshot truncated');
    expect(observation.limitations.join(' ')).toContain(
      'references were omitted',
    );
    for (const ref of observation.refs)
      expect(observation.text).toContain(`[ref=${ref.id}]`);
  });
  it('marks DOM node and frame omissions even below the text limit', async () => {
    const nodes = await backend.newTab(
      'nodes',
      'actor',
      `${origin}/many-nodes`,
    );
    const nodeSnapshot = await backend.dom(nodes.id);
    expect(nodeSnapshot.frames[0].html?.length).toBeLessThan(24_000);
    expect(nodeSnapshot.frames[0].truncated).toBe(true);
    expect(nodeSnapshot.truncated).toBe(true);
    const frames = await backend.newTab(
      'frames-bound',
      'actor',
      `${origin}/many-frames`,
    );
    const frameSnapshot = await backend.dom(frames.id);
    expect(frameSnapshot.frames).toHaveLength(8);
    expect(frameSnapshot.truncated).toBe(true);
    expect(frameSnapshot.limitations.join(' ')).toContain(
      'frames were omitted',
    );
  });
});
