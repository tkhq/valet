import {
  chromium,
  type BrowserContext,
  type Page,
  type Locator,
  type FrameLocator,
  type ElementHandle,
  type Dialog,
} from 'playwright-core';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  BrowserArtifact,
  BrowserCapability,
  BrowserElementRef,
  BrowserHumanInput,
  BrowserLocator,
  BrowserObservation,
  BrowserTabInfo,
  BrowserViewport,
} from '@valet/shared';
import { FileBroker } from './files.js';
import {
  BrowserFault,
  canonicalHash,
  number,
  object,
  string,
} from './protocol.js';
import { documentation } from './registry.js';
interface TabRecord {
  info: BrowserTabInfo;
  page: Page;
  refs: Map<
    string,
    {
      ref: BrowserElementRef;
      handle: ElementHandle;
      fingerprint: string;
      thread: string;
    }
  >;
  logs: unknown[];
  network: unknown[];
  dialog?: { id: string; value: Dialog };
  baselines: Map<string, BrowserObservation>;
  observedThreads: Set<string>;
}
export interface BrowserBackendOptions {
  runtimeId: string;
  profile: string;
  files: FileBroker;
  launch?: {
    executablePath: string;
    args?: string[];
    env?: Record<string, string>;
    confinement: 'bubblewrap';
  };
  testOnlyUnconfined?: boolean;
  onTabs?: (tabs: BrowserTabInfo[]) => void;
  onDialog?: (tabId: string, id: string, kind: string, message: string) => void;
}
export class PlaywrightBackend {
  private context?: BrowserContext;
  private records = new Map<string, TabRecord>();
  private selectedId?: string;
  private heldKeys = new Map<string, Set<string>>();
  private heldButtons = new Map<string, Set<'left' | 'right' | 'middle'>>();
  private stagedUploads = new Map<
    string,
    Awaited<ReturnType<FileBroker['upload']>>
  >();
  private clipboard = '';
  private history: { tabId: string; url: string; timestamp: number }[] = [];
  private inventories = new Map<
    string,
    { tabId: string; documentId: string; urls: string[] }
  >();
  private quiet = false;
  readonly capabilities: Record<string, BrowserCapability> = {
    automation: { available: true },
    aria: { available: true },
    screenshot: { available: true },
    locators: { available: true },
    domSnapshot: { available: true },
    immutableEvaluate: { available: true },
    downloads: { available: true },
    uploads: { available: true },
    export: { available: true },
    clipboardText: { available: true },
    clipboardHtml: {
      available: false,
      reason: 'HTML clipboard paste is unavailable. Use literal text paste.',
    },
    assets: { available: true },
    diagnostics: { available: true },
    viewer: { available: true },
    webmcp: {
      available: false,
      reason:
        'The pinned Chromium build does not expose the reviewed WebMCP registration contract.',
    },
    nativeDialogs: {
      available: false,
      reason: 'Use Valet file and JavaScript dialog controls.',
    },
    privilegedEvaluate: {
      available: false,
      reason: 'Evaluate uses an immutable DOM snapshot.',
    },
  };
  constructor(private readonly options: BrowserBackendOptions) {}
  async start() {
    if (!this.options.launch && !this.options.testOnlyUnconfined)
      throw new BrowserFault(
        'BROWSER_UNAVAILABLE',
        'The browser network confinement launcher is missing.',
        'Install the verified Linux browser image.',
      );
    this.context = await chromium.launchPersistentContext(
      this.options.profile,
      {
        channel: 'chromium',
        headless: true,
        chromiumSandbox: true,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        // Chromium's private /tmp is not visible to the trusted file broker.
        downloadsPath: join(this.options.files.root, 'downloads'),
        serviceWorkers: 'allow',
        ...(this.options.launch
          ? {
              executablePath: this.options.launch.executablePath,
              args: this.options.launch.args,
              env: this.options.launch.env,
            }
          : {}),
      },
    );
    this.context.setDefaultTimeout(15_000);
    this.context.setDefaultNavigationTimeout(30_000);
    // HTTP routing is defense in depth. The network namespace and broker own network policy.
    await this.context.route('**/*', (route) => {
      const protocol = new URL(route.request().url()).protocol;
      return protocol === 'file:'
        ? route.abort('accessdenied')
        : route.continue();
    });
    for (const page of this.context.pages()) await page.close();
    this.context.on('page', (page) => {
      if (![...this.records.values()].some((r) => r.page === page))
        void this.register(page, null, 'browser');
    });
  }
  tabs() {
    return [...this.records.values()].map((record) => ({ ...record.info }));
  }
  info(id: string) {
    return { ...this.record(id).info };
  }
  private record(id: string) {
    const r = this.records.get(id);
    if (!r)
      throw new BrowserFault(
        'STALE_REFERENCE',
        'The tab reference is unavailable.',
        'List tabs and select a current tab.',
      );
    return r;
  }
  private async register(
    page: Page,
    owner: string | null,
    actor: string,
  ): Promise<BrowserTabInfo> {
    const existing = [...this.records.values()].find((r) => r.page === page);
    if (existing) {
      if (owner) {
        existing.info.ownerThreadId = owner;
        existing.info.actorId = actor;
        existing.info.mark = 'temporary';
      }
      return existing.info;
    }
    const info: BrowserTabInfo = {
      id: randomUUID(),
      runtimeId: this.options.runtimeId,
      documentId: randomUUID(),
      url: page.url(),
      title: '',
      ownerThreadId: owner,
      actorId: actor,
      mark: owner ? 'temporary' : 'user',
    };
    const record: TabRecord = {
      info,
      page,
      refs: new Map(),
      logs: [],
      network: [],
      baselines: new Map(),
      observedThreads: new Set(),
    };
    this.records.set(info.id, record);
    this.selectedId = info.id;
    const bounded = (buffer: unknown[], value: unknown) => {
      if (!this.quiet) {
        buffer.push(value);
        if (buffer.length > 200) buffer.shift();
      }
    };
    page.on('console', (message) =>
      bounded(record.logs, {
        level: message.type(),
        text: message.text().slice(0, 2000),
        timestamp: Date.now(),
        url: sanitize(message.location().url),
      }),
    );
    page.on('pageerror', (error) =>
      bounded(record.logs, {
        level: 'error',
        text: error.message.slice(0, 2000),
        timestamp: Date.now(),
      }),
    );
    page.on('requestfinished', (request) =>
      bounded(record.network, {
        method: request.method(),
        url: sanitize(request.url()),
        resourceType: request.resourceType(),
        timestamp: Date.now(),
      }),
    );
    page.on('framenavigated', (frame) => {
      record.info.documentId = randomUUID();
      this.clearRefs(record);
      if (frame === page.mainFrame()) {
        record.info.url = page.url();
        this.history.push({
          tabId: info.id,
          url: sanitize(page.url()),
          timestamp: Date.now(),
        });
        if (this.history.length > 200) this.history.shift();
        void page
          .title()
          .then((title) => {
            info.title = title;
            this.changed();
          })
          .catch(() => {});
      }
      this.changed();
    });
    page.on('popup', (popup) => {
      void this.register(popup, info.ownerThreadId, info.actorId);
    });
    page.on('dialog', (value) => {
      record.dialog = { id: randomUUID(), value };
      this.options.onDialog?.(
        info.id,
        record.dialog.id,
        value.type(),
        value.message().slice(0, 2000),
      );
    });
    page.on('download', (download) => {
      void (async () => {
        try {
          const stream = await download.createReadStream();
          if (!stream) return;
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const part of stream) {
            const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
            size += chunk.length;
            if (size > 100 * 1024 * 1024) {
              await download.cancel();
              throw new BrowserFault(
                'QUOTA_EXCEEDED',
                'The download is too large.',
                'Use a smaller download.',
              );
            }
            chunks.push(chunk);
          }
          await this.options.files.create(
            Buffer.concat(chunks),
            'application/octet-stream',
            download.suggestedFilename(),
            {
              tabId: info.id,
              documentId: info.documentId,
              url: sanitize(download.url()),
            },
          );
        } finally {
          await download.delete();
        }
      })().catch((error) =>
        bounded(record.logs, {
          level: 'error',
          text: error instanceof Error ? error.message : 'Download failed.',
        }),
      );
    });
    page.on('close', () => {
      this.clearRefs(record);
      this.records.delete(info.id);
      if (this.selectedId === info.id)
        this.selectedId = this.records.keys().next().value;
      this.changed();
    });
    this.changed();
    return info;
  }
  private changed() {
    this.options.onTabs?.(this.tabs());
  }
  private clearRefs(record: TabRecord) {
    for (const item of record.refs.values())
      void item.handle.dispose().catch(() => {});
    record.refs.clear();
    record.baselines.clear();
    record.observedThreads.clear();
  }
  invalidate() {
    for (const record of this.records.values()) this.clearRefs(record);
  }
  setPrivate(value: boolean) {
    this.quiet = value;
  }
  async newTab(thread: string | null, actor: string, url?: string) {
    const destination = url ? checkedURL(url) : undefined;
    if (this.records.size >= 8)
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'The browser tab limit was reached.',
        'Close an unused tab.',
      );
    if (!this.context)
      throw new BrowserFault(
        'BROWSER_UNAVAILABLE',
        'The browser is not started.',
        'Start the browser runtime.',
      );
    const page = await this.context.newPage();
    const info = await this.register(page, thread, actor);
    if (destination)
      await page.goto(destination, { waitUntil: 'domcontentloaded' });
    return { ...info };
  }
  selected() {
    return this.selectedId;
  }
  dialogs() {
    return [...this.records.values()]
      .filter((r) => r.dialog)
      .map((r) => ({
        tabId: r.info.id,
        dialogId: r.dialog!.id,
        kind: r.dialog!.value.type(),
        message: r.dialog!.value.message().slice(0, 2000),
      }));
  }
  select(id: string) {
    this.record(id);
    this.selectedId = id;
  }
  async turnEnd(thread: string) {
    for (const r of [...this.records.values()])
      if (r.info.ownerThreadId === thread && r.info.mark === 'temporary')
        await r.page.close();
      else if (r.info.ownerThreadId === thread && r.info.mark === 'handoff')
        r.info.mark = 'temporary';
    this.changed();
  }
  async viewport(id: string): Promise<BrowserViewport> {
    return this.record(id).page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio,
      scrollX,
      scrollY,
    }));
  }
  async observe(id: string, thread: string): Promise<BrowserObservation> {
    const record = this.record(id);
    const snapshotId = randomUUID();
    const rawText = await record.page.ariaSnapshot({
      mode: 'ai',
      boxes: true,
      timeout: 15_000,
    });
    const omissions = new Set<string>();
    if (rawText.length > 24_000) omissions.add('Snapshot text was omitted.');
    let text = rawText.slice(0, 24_000).replace(/\[ref=[^\]]*$/, '');
    let refs: BrowserElementRef[] = [];
    const matches = [...text.matchAll(/\[ref=([^\]]+)\]/g)];
    for (const [matchIndex, match] of matches.entries()) {
      const aria = match[1];
      if (matchIndex >= 128) {
        omissions.add(
          'Snapshot references were omitted after the 128-reference limit.',
        );
        text = text.replace(match[0], '[reference omitted]');
        continue;
      }
      let handle: ElementHandle | null = null;
      let frameId = 'main';
      for (const [index, frame] of record.page.frames().entries()) {
        try {
          handle = await frame
            .locator(`aria-ref=${aria}`)
            .elementHandle({ timeout: 100 });
          if (handle) {
            frameId = String(index);
            break;
          }
        } catch {
          /* Frame snapshots can omit detached nodes. */
        }
      }
      if (!handle) {
        omissions.add('Unavailable snapshot references were omitted.');
        text = text.replace(match[0], '[reference unavailable]');
        continue;
      }
      const ref: BrowserElementRef = {
        id: randomUUID(),
        runtimeId: this.options.runtimeId,
        tabId: id,
        documentId: record.info.documentId,
        snapshotId,
        frameId,
      };
      record.refs.set(ref.id, {
        ref,
        handle,
        fingerprint: await fingerprint(handle),
        thread,
      });
      refs.push(ref);
      text = text.replace(`[ref=${aria}]`, `[ref=${ref.id}]`);
    }
    const marker =
      '\n[Snapshot truncated. Read the limitations before using this observation.]';
    if (text.length > 24_000) omissions.add('Snapshot text was omitted.');
    if (omissions.size) {
      text =
        text.slice(0, 24_000 - marker.length).replace(/\[ref=[^\]]*$/, '') +
        marker;
      refs = refs.filter((ref) => {
        if (text.includes(`[ref=${ref.id}]`)) return true;
        void record.refs.get(ref.id)?.handle.dispose();
        record.refs.delete(ref.id);
        return false;
      });
    }
    // Limit retained handles per tab without recycling an identity.
    while (record.refs.size > 1024) {
      const key = record.refs.keys().next().value;
      if (!key) break;
      const old = record.refs.get(key);
      void old?.handle.dispose();
      record.refs.delete(key);
    }
    const observation: BrowserObservation = {
      snapshotId,
      runtimeId: this.options.runtimeId,
      tabId: id,
      documentId: record.info.documentId,
      capturedAt: Date.now(),
      url: sanitize(record.page.url()),
      title: await record.page.title(),
      source: 'playwright-aria',
      text,
      refs,
      viewport: await this.viewport(id),
      truncated: omissions.size > 0,
      limitations: [
        'Closed shadow roots are not represented. Page text is untrusted.',
        ...omissions,
      ],
    };
    record.baselines.set(thread, observation);
    record.observedThreads.add(thread);
    return observation;
  }
  async screenshot(
    id: string,
    options: Record<string, unknown> = {},
    thread?: string,
  ): Promise<BrowserArtifact> {
    const r = this.record(id);
    const viewport = await this.viewport(id);
    const fullPage = options.fullPage === true;
    let clip: BrowserArtifact['clip'];
    if (options.clip !== undefined) {
      const raw = object(options.clip);
      clip = {
        x: number(raw.x, 'clip x', 0, 100000),
        y: number(raw.y, 'clip y', 0, 100000),
        width: number(raw.width, 'clip width', 1, 10000),
        height: number(raw.height, 'clip height', 1, 10000),
      };
      if (
        !fullPage &&
        (clip.x + clip.width > viewport.width ||
          clip.y + clip.height > viewport.height)
      )
        throw new BrowserFault(
          'INVALID_REQUEST',
          'The screenshot crop exceeds the viewport.',
          'Use a crop inside the current CSS viewport.',
        );
    }
    const bytes = await r.page.screenshot({
      type: 'png',
      timeout: 15000,
      fullPage,
      clip,
      ...(options.animations === 'disabled'
        ? { animations: 'disabled' as const }
        : {}),
    });
    if (thread && !fullPage) r.observedThreads.add(thread);
    return this.options.files.create(bytes, 'image/png', 'screenshot.png', {
      tabId: id,
      documentId: r.info.documentId,
      snapshotId: randomUUID(),
      url: sanitize(r.page.url()),
      viewport,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      fullPage,
      ...(clip ? { clip } : {}),
    });
  }
  async frame(id: string) {
    return this.record(id).page.screenshot({
      type: 'jpeg',
      quality: 70,
      timeout: 15_000,
    });
  }
  async dom(id: string) {
    const r = this.record(id);
    const frames = [];
    const availableFrames = r.page.frames();
    for (const [index, frame] of availableFrames.slice(0, 8).entries()) {
      try {
        const snapshot = await frame.evaluate(() => {
          const output = document.implementation.createHTMLDocument('');
          let count = 0;
          let truncated = false;
          const copy = (source: Node): Node | null => {
            if (++count > 2000) {
              truncated = true;
              return null;
            }
            if (source.nodeType === Node.TEXT_NODE) {
              if ((source.textContent?.length ?? 0) > 2000) truncated = true;
              return output.createTextNode(
                source.textContent?.slice(0, 2000) ?? '',
              );
            }
            if (
              !(source instanceof Element) ||
              source.matches(
                'script,style,noscript,input[type=password],input[type=hidden]',
              )
            )
              return null;
            const target = output.createElement(source.tagName.toLowerCase());
            for (const attr of [...source.attributes]) {
              if (
                ![
                  'id',
                  'class',
                  'role',
                  'aria-label',
                  'aria-labelledby',
                  'aria-describedby',
                  'href',
                  'src',
                  'alt',
                  'title',
                  'name',
                  'type',
                  'placeholder',
                  'data-testid',
                  'checked',
                  'disabled',
                  'selected',
                ].includes(attr.name)
              )
                continue;
              let value = attr.value;
              if (attr.name === 'href' || attr.name === 'src') {
                try {
                  const url = new URL(value, document.baseURI);
                  url.username = '';
                  url.password = '';
                  url.search = '';
                  url.hash = '';
                  value = url.href;
                } catch {
                  continue;
                }
              }
              if (value.length > 2000) truncated = true;
              target.setAttribute(attr.name, value.slice(0, 2000));
            }
            const box = source.getBoundingClientRect();
            const style = getComputedStyle(source);
            target.setAttribute(
              'data-valet-visible',
              source.getClientRects().length &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
                ? '1'
                : '0',
            );
            target.setAttribute(
              'data-valet-box',
              JSON.stringify({
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
              }),
            );
            for (const child of source.childNodes) {
              if (count >= 2000) {
                truncated = true;
                break;
              }
              const copied = copy(child);
              if (copied) target.appendChild(copied);
            }
            if (source.shadowRoot) {
              const shadow = output.createElement('valet-shadow-root');
              for (const child of source.shadowRoot.childNodes) {
                if (count >= 2000) {
                  truncated = true;
                  break;
                }
                const copied = copy(child);
                if (copied) shadow.appendChild(copied);
              }
              target.appendChild(shadow);
            }
            return target;
          };
          const root = copy(document.documentElement);
          return {
            html: root instanceof Element ? root.outerHTML : '',
            truncated,
          };
        });
        frames.push({
          frameId: String(index),
          url: sanitize(frame.url()),
          html: snapshot.html.slice(0, 24_000),
          truncated: snapshot.truncated || snapshot.html.length > 24_000,
        });
      } catch {
        frames.push({
          frameId: String(index),
          error: 'Frame snapshot is unavailable.',
        });
      }
    }
    return {
      snapshotId: randomUUID(),
      tabId: id,
      documentId: r.info.documentId,
      frames,
      truncated:
        availableFrames.length > 8 ||
        frames.some((frame) => frame.truncated || frame.error),
      limitations: [
        'Closed shadow roots are unavailable. Snapshot attributes exclude hidden values and URL queries.',
        ...(availableFrames.length > 8
          ? ['Snapshot frames were omitted after the eight-frame limit.']
          : []),
        ...(frames.some((frame) => frame.truncated)
          ? [
              'Snapshot nodes, text, or attributes were omitted at the observation limits.',
            ]
          : []),
        ...(frames.some((frame) => frame.error)
          ? ['Unavailable frames were omitted.']
          : []),
      ],
    };
  }
  async releaseInput() {
    for (const [id, keys] of this.heldKeys) {
      const record = this.records.get(id);
      if (record)
        for (const key of keys)
          await record.page.keyboard.up(key).catch(() => {});
    }
    for (const [id, buttons] of this.heldButtons) {
      const record = this.records.get(id);
      if (record)
        for (const button of buttons)
          await record.page.mouse.up({ button }).catch(() => {});
    }
    this.heldKeys.clear();
    this.heldButtons.clear();
  }
  private buildLocator(query: BrowserLocator): Locator {
    if (query.runtimeId !== this.options.runtimeId)
      throw new BrowserFault(
        'RUNTIME_CHANGED',
        'The locator runtime changed.',
        'Get a fresh tab handle.',
      );
    const page = this.record(query.tabId).page;
    let base: Page | Locator | FrameLocator = page;
    if (!Array.isArray(query.steps) || query.steps.length > 32)
      throw new BrowserFault(
        'INVALID_REQUEST',
        'The locator chain is invalid.',
        'Use a shorter locator chain.',
      );
    for (const step of query.steps) {
      switch (step.kind) {
        case 'role':
          base = base.getByRole(
            step.value as Parameters<Page['getByRole']>[0],
            { name: step.name, exact: step.exact },
          );
          break;
        case 'label':
          base = base.getByLabel(step.value, { exact: step.exact });
          break;
        case 'placeholder':
          base = base.getByPlaceholder(step.value, { exact: step.exact });
          break;
        case 'text':
          base = base.getByText(step.value, { exact: step.exact });
          break;
        case 'testId':
          base = base.getByTestId(step.value);
          break;
        case 'css':
          base = base.locator(step.value);
          break;
        case 'frame':
          base = base.frameLocator(step.value);
          break;
        case 'first':
          if (!isLocator(base))
            throw new BrowserFault(
              'INVALID_REQUEST',
              'first requires a locator.',
              'Select an element locator first.',
            );
          base = base.first();
          break;
        case 'last':
          if (!isLocator(base))
            throw new BrowserFault(
              'INVALID_REQUEST',
              'last requires a locator.',
              'Select an element locator first.',
            );
          base = base.last();
          break;
        case 'nth':
          if (!isLocator(base))
            throw new BrowserFault(
              'INVALID_REQUEST',
              'nth requires a locator.',
              'Select an element locator first.',
            );
          base = base.nth(number(step.index, 'index', 0, 10000));
          break;
        case 'filter':
          if (!isLocator(base))
            throw new BrowserFault(
              'INVALID_REQUEST',
              'filter requires a locator.',
              'Select an element locator first.',
            );
          base = base.filter(step);
          break;
        case 'and':
        case 'or':
          if (!isLocator(base))
            throw new BrowserFault(
              'INVALID_REQUEST',
              'Locator combination requires an element locator.',
              'Select an element locator first.',
            );
          base =
            step.kind === 'and'
              ? base.and(this.buildLocator(step.locator))
              : base.or(this.buildLocator(step.locator));
          break;
        default:
          throw new BrowserFault(
            'INVALID_REQUEST',
            'Unknown locator step.',
            'Read browser.describe for supported locators.',
          );
      }
    }
    if (!('count' in base))
      throw new BrowserFault(
        'INVALID_REQUEST',
        'The locator does not select an element.',
        'Add an element locator.',
      );
    return base;
  }
  private async strict(locator: Locator) {
    const count = await locator.count();
    if (count !== 1)
      throw new BrowserFault(
        count > 1 ? 'AMBIGUOUS_LOCATOR' : 'STALE_REFERENCE',
        `The locator matches ${count} elements.`,
        count > 1
          ? 'Use a more specific locator or explicit nth().'
          : 'Take a fresh observation and locate the element again.',
      );
    return locator;
  }
  private async ref(record: TabRecord, target: unknown, thread: string) {
    const r = object(target);
    const item = record.refs.get(string(r.id, 'reference'));
    if (
      !item ||
      item.thread !== thread ||
      r.runtimeId !== this.options.runtimeId ||
      r.documentId !== record.info.documentId ||
      r.snapshotId !== item.ref.snapshotId ||
      r.frameId !== item.ref.frameId ||
      item.fingerprint === 'detached' ||
      r.tabId !== record.info.id ||
      (await fingerprint(item.handle)) !== item.fingerprint
    )
      throw new BrowserFault(
        'STALE_REFERENCE',
        'The element reference is stale.',
        'Take a fresh observation before acting.',
      );
    return item.handle;
  }
  async policyState(method: string, params: Record<string, unknown>) {
    const query = params.locator ? object(params.locator) : undefined;
    const tabId =
      typeof params.tabId === 'string'
        ? params.tabId
        : typeof query?.tabId === 'string'
          ? query.tabId
          : undefined;
    const r = tabId ? this.record(tabId) : undefined;
    const url =
      typeof params.url === 'string' ? checkedURL(params.url) : r?.page.url();
    const state: {
      origin: string;
      tabId?: string;
      documentId?: string;
      target?: unknown;
      uploads?: unknown;
    } = {
      origin:
        url && url !== 'about:blank' ? new URL(url).origin : 'about:blank',
      ...(r ? { tabId: r.info.id, documentId: r.info.documentId } : {}),
    };
    if (
      query &&
      method.startsWith('locator.') &&
      !['locator.count', 'locator.allTextContents'].includes(method)
    ) {
      const locator = this.buildLocator({
        ...query,
        tabId: string(query.tabId, 'tab ID'),
        runtimeId: string(query.runtimeId, 'runtime ID'),
        steps: query.steps,
      } as BrowserLocator);
      state.target = await locator.evaluateAll((elements) =>
        elements.slice(0, 5).map((element) => ({
          tag: element.tagName,
          role: element.getAttribute('role'),
          label: element.getAttribute('aria-label'),
          text: element.textContent?.slice(0, 500),
          href: element.getAttribute('href'),
          action: element.getAttribute('formaction'),
          disabled: element.hasAttribute('disabled'),
          labels:
            element instanceof HTMLInputElement
              ? [...(element.labels ?? [])].map((label) => label.textContent)
              : [],
        })),
      );
    }
    if (method === 'tab.upload') {
      const files = await this.options.files.upload(
        Array.isArray(params.paths)
          ? params.paths.map((path) => string(path, 'upload path'))
          : [],
      );
      state.uploads = files.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        bytes: file.buffer.length,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
      }));
      this.stagedUploads.set(canonicalHash(params), files);
      while (this.stagedUploads.size > 4)
        this.stagedUploads.delete(this.stagedUploads.keys().next().value!);
    }
    return state;
  }
  async execute(
    method: string,
    params: Record<string, unknown>,
    thread: string,
    actor: string,
  ): Promise<unknown> {
    if (method === 'tabs.list') return this.tabs();
    if (method === 'tabs.get') return this.info(string(params.id, 'tab ID'));
    if (method === 'tabs.selected')
      return this.selectedId ? this.info(this.selectedId) : undefined;
    if (method === 'tabs.new')
      return this.newTab(
        thread,
        actor,
        typeof params.url === 'string' ? params.url : undefined,
      );
    if (method === 'browser.documentation') return documentation();
    if (method === 'browser.history') return this.history.slice(-50);
    if (method === 'browser.downloads')
      return this.options.files
        .list()
        .filter((a) => a.mimeType === 'application/octet-stream');
    if (method.startsWith('locator.'))
      return this.locatorAction(method.slice(8), params);
    const record = this.record(string(params.tabId, 'tab ID'));
    if (params.runtimeId !== this.options.runtimeId)
      throw new BrowserFault(
        'RUNTIME_CHANGED',
        'The tab handle belongs to an old runtime.',
        'Get a fresh tab handle.',
      );
    const page = record.page;
    const args = Array.isArray(params.args) ? params.args : [];
    switch (method) {
      case 'tab.goto':
        await page.goto(checkedURL(string(params.url, 'URL')), {
          waitUntil: 'domcontentloaded',
        });
        return;
      case 'tab.back':
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return;
      case 'tab.forward':
        await page.goForward({ waitUntil: 'domcontentloaded' });
        return;
      case 'tab.reload':
        await page.reload({ waitUntil: 'domcontentloaded' });
        return;
      case 'tab.close':
        await page.close();
        return;
      case 'tab.title':
        return page.title();
      case 'tab.url':
        return page.url();
      case 'tab.getAXState':
        return this.observe(record.info.id, thread);
      case 'tab.getScreenshot':
        return this.screenshot(
          record.info.id,
          params.options ? object(params.options) : {},
          thread,
        );
      case 'tab.getAXStateAndScreenshot':
        return {
          observation: await this.observe(record.info.id, thread),
          artifact: await this.screenshot(
            record.info.id,
            params.options ? object(params.options) : {},
            thread,
          ),
        };
      case 'tab.domSnapshot':
        return this.dom(record.info.id);
      case 'tab.markDeliverable':
        record.info.mark = 'deliverable';
        this.changed();
        return;
      case 'tab.markHandoff':
        record.info.mark = 'handoff';
        this.changed();
        return;
      case 'tab.getJsDialog':
        return record.dialog
          ? {
              id: record.dialog.id,
              kind: record.dialog.value.type(),
              message: record.dialog.value.message(),
            }
          : undefined;
      case 'tab.dialogRespond':
        if (!record.dialog || record.dialog.id !== params.dialogId)
          throw new BrowserFault(
            'STALE_REFERENCE',
            'The dialog is no longer available.',
            'Read the current dialog.',
          );
        if (params.accept === true)
          await record.dialog.value.accept(
            typeof params.text === 'string' ? params.text : undefined,
          );
        else await record.dialog.value.dismiss();
        record.dialog = undefined;
        return;
      case 'tab.waitForURL':
        await page.waitForURL(string(params.url, 'URL'), {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        });
        return;
      case 'tab.waitForLoadState':
        if (params.state !== 'load' && params.state !== 'domcontentloaded')
          throw new BrowserFault(
            'INVALID_REQUEST',
            'Unsupported load state.',
            'Use load or domcontentloaded.',
          );
        await page.waitForLoadState(params.state, { timeout: 15_000 });
        return;
      case 'tab.logs':
        return record.logs.slice(-50);
      case 'tab.network':
        return record.network.slice(-50);
      case 'tab.clipboardRead':
        return this.clipboard;
      case 'tab.clipboardWrite':
        this.clipboard = string(params.text, 'clipboard text', 24000);
        return;
      case 'tab.export':
        return this.exportContent(record, String(params.format));
      case 'tab.assets':
        return this.assets(record);
      case 'tab.bundleAssets':
        return this.bundle(record, string(params.inventoryId, 'inventory ID'));
      case 'tab.webmcpList': {
        const present = await page.evaluate(() =>
          Reflect.has(document, 'modelContext'),
        );
        this.capabilities.webmcp = {
          available: false,
          reason: present
            ? 'document.modelContext is present, but its discovery contract is not verified.'
            : 'The browser does not expose document.modelContext.',
        };
        throw new BrowserFault(
          'UNSUPPORTED_CAPABILITY',
          this.capabilities.webmcp.reason!,
          'Use normal page controls.',
        );
      }
      case 'tab.webmcpCall':
        throw new BrowserFault(
          'UNSUPPORTED_CAPABILITY',
          this.capabilities.webmcp.reason!,
          'Use normal page controls.',
        );
      case 'tab.upload': {
        const key = canonicalHash(params);
        const files = this.stagedUploads.get(key);
        if (!files)
          throw new BrowserFault(
            'APPROVAL_STALE',
            'The approved upload bytes are unavailable.',
            'Select the files and approve the upload again.',
          );
        this.stagedUploads.delete(key);
        const handle = await this.ref(record, params.target, thread);
        await handle.setInputFiles(files);
        return;
      }
      default:
        return this.inputAction(record, method, args, thread);
    }
  }
  private async locatorAction(action: string, params: Record<string, unknown>) {
    const raw = object(params.locator);
    const query = {
      ...raw,
      tabId: string(raw.tabId, 'tab ID'),
      runtimeId: string(raw.runtimeId, 'runtime ID'),
      steps: raw.steps,
    } as BrowserLocator;
    const locator = this.buildLocator(query);
    const args = Array.isArray(params.args) ? params.args : [];
    if (action === 'count') return locator.count();
    if (action === 'allTextContents')
      return (await locator.allTextContents())
        .slice(0, 200)
        .map((t) => t.slice(0, 2000));
    await this.strict(locator);
    switch (action) {
      case 'textContent':
        return (await locator.textContent())?.slice(0, 24000);
      case 'innerText':
        return (await locator.innerText()).slice(0, 24000);
      case 'getAttribute': {
        const name = string(args[0], 'attribute');
        if (
          !/^(aria-|data-testid$|role$|title$|href$|alt$|name$|type$|placeholder$)/.test(
            name,
          )
        )
          throw new BrowserFault(
            'ORIGIN_DENIED',
            'This attribute is outside the observation scope.',
            'Use a rendered DOM snapshot.',
          );
        return locator.getAttribute(name);
      }
      case 'isVisible':
        return locator.isVisible();
      case 'isEnabled':
        return locator.isEnabled();
      case 'click':
        await locator.click();
        return;
      case 'dblclick':
        await locator.dblclick();
        return;
      case 'fill':
        await locator.fill(
          typeof args[0] === 'string' ? args[0] : string(args[0], 'value'),
        );
        return;
      case 'type':
      case 'pressSequentially':
        await locator.pressSequentially(string(args[0], 'text', 24000));
        return;
      case 'press':
        await locator.press(string(args[0], 'key'));
        return;
      case 'check':
        await locator.check();
        return;
      case 'uncheck':
        await locator.uncheck();
        return;
      case 'setChecked':
        if (typeof args[0] !== 'boolean')
          throw new BrowserFault(
            'INVALID_REQUEST',
            'Checked state must be boolean.',
            'Use true or false.',
          );
        await locator.setChecked(args[0]);
        return;
      case 'selectOption':
        return locator.selectOption(
          Array.isArray(args[0])
            ? args[0].map((v) => string(v, 'option'))
            : string(args[0], 'option'),
        );
      case 'waitFor':
        await locator.waitFor({ state: 'visible', timeout: 15_000 });
        return;
      default:
        throw new BrowserFault(
          'UNSUPPORTED_CAPABILITY',
          'Unsupported locator action.',
          'Read browser.describe.',
        );
    }
  }
  private async inputAction(
    record: TabRecord,
    method: string,
    args: unknown[],
    thread: string,
  ) {
    const page = record.page;
    const target = args[0];
    const point =
      target &&
      typeof target === 'object' &&
      typeof Reflect.get(target, 'x') === 'number'
        ? {
            x: number(Reflect.get(target, 'x'), 'x', 0, 1280),
            y: number(Reflect.get(target, 'y'), 'y', 0, 800),
          }
        : undefined;
    if (method === 'tab.drag') {
      const from = object(args[0]),
        to = object(args[1]);
      await page.mouse.move(
        number(from.x, 'x', 0, 1280),
        number(from.y, 'y', 0, 800),
      );
      await page.mouse.down();
      await page.mouse.move(
        number(to.x, 'x', 0, 1280),
        number(to.y, 'y', 0, 800),
        { steps: 10 },
      );
      await page.mouse.up();
      return;
    }
    if (point && !record.observedThreads.has(thread))
      throw new BrowserFault(
        'STALE_REFERENCE',
        'Viewport input requires a current observation.',
        'Take a viewport screenshot or accessibility observation first.',
      );
    const handle =
      !point && target ? await this.ref(record, target, thread) : undefined;
    switch (method) {
      case 'tab.click':
        if (point) await page.mouse.click(point.x, point.y);
        else if (handle) await handle.click();
        else
          throw new BrowserFault(
            'INVALID_REQUEST',
            'Click requires a target.',
            'Use an element reference or viewport point.',
          );
        return;
      case 'tab.hover':
        if (point) await page.mouse.move(point.x, point.y);
        else await handle?.hover();
        return;
      case 'tab.setValue':
        if (!handle)
          throw new BrowserFault(
            'INVALID_REQUEST',
            'setValue requires an element reference.',
            'Observe the page and select the field.',
          );
        await handle.fill(
          typeof args[1] === 'string' ? args[1] : string(args[1], 'value'),
        );
        return;
      case 'tab.typeText':
      case 'tab.paste':
        if (handle) await handle.focus();
        await page.keyboard.insertText(string(args[1], 'text', 24000));
        return;
      case 'tab.pressKey':
        if (handle) await handle.focus();
        await page.keyboard.press(string(args[1], 'key'));
        return;
      case 'tab.scroll':
        if (point) await page.mouse.move(point.x, point.y);
        else await handle?.hover();
        {
          const direction = String(args[1]);
          const amount =
            800 *
            (typeof args[2] === 'number' ? number(args[2], 'pages', 0, 20) : 1);
          await page.mouse.wheel(
            direction === 'left' ? -amount : direction === 'right' ? amount : 0,
            direction === 'up' ? -amount : direction === 'down' ? amount : 0,
          );
        }
        return;
      case 'tab.selectText':
        if (!handle)
          throw new BrowserFault(
            'INVALID_REQUEST',
            'Text selection requires an element reference.',
            'Observe the page and select an element.',
          );
        await handle.evaluate(
          (element, text) => {
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
            );
            const nodes: Text[] = [];
            let node = walker.nextNode();
            while (node) {
              if (node instanceof Text) nodes.push(node);
              node = walker.nextNode();
            }
            const full = nodes.map((n) => n.data).join('');
            const start = full.indexOf(text);
            if (start < 0) throw Error('The requested text is absent.');
            const end = start + text.length;
            const range = document.createRange();
            let offset = 0;
            for (const item of nodes) {
              if (start >= offset && start < offset + item.length)
                range.setStart(item, start - offset);
              if (end > offset && end <= offset + item.length)
                range.setEnd(item, end - offset);
              offset += item.length;
            }
            const selection = getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          },
          string(args[1], 'selection text', 24000),
        );
        return;
      case 'tab.performSecondaryAction':
        if (args[1] !== 'contextmenu' || !handle)
          throw new BrowserFault(
            'UNSUPPORTED_CAPABILITY',
            'This secondary action is unavailable.',
            'Use contextmenu with an element reference.',
          );
        await handle.click({ button: 'right' });
        return;
      default:
        throw new BrowserFault(
          'UNSUPPORTED_CAPABILITY',
          `Browser method ${method} is unavailable.`,
          'Read browser.describe.',
        );
    }
  }
  async humanInput(id: string, documentId: string, input: BrowserHumanInput) {
    const r = this.record(id);
    if (r.info.documentId !== documentId)
      throw new BrowserFault(
        'STALE_REFERENCE',
        'The viewer frame belongs to an old document.',
        'Refresh the browser frame.',
      );
    switch (input.type) {
      case 'click':
        await r.page.mouse.click(
          number(input.x, 'x', 0, 1280),
          number(input.y, 'y', 0, 800),
          { button: input.button },
        );
        return;
      case 'move':
        await r.page.mouse.move(
          number(input.x, 'x', 0, 1280),
          number(input.y, 'y', 0, 800),
        );
        return;
      case 'wheel':
        await r.page.mouse.wheel(
          number(input.deltaX, 'deltaX', -10000, 10000),
          number(input.deltaY, 'deltaY', -10000, 10000),
        );
        return;
      case 'key':
        if (input.phase === 'down') {
          await r.page.keyboard.down(string(input.key, 'key'));
          const keys = this.heldKeys.get(id) ?? new Set<string>();
          keys.add(input.key);
          this.heldKeys.set(id, keys);
        } else if (input.phase === 'up') {
          await r.page.keyboard.up(string(input.key, 'key'));
          this.heldKeys.get(id)?.delete(input.key);
        } else await r.page.keyboard.press(string(input.key, 'key'));
        return;
      case 'pointer':
        await r.page.mouse.move(
          number(input.x, 'x', 0, 1280),
          number(input.y, 'y', 0, 800),
        );
        if (input.phase === 'down') {
          await r.page.mouse.down({ button: input.button });
          const buttons =
            this.heldButtons.get(id) ?? new Set<'left' | 'right' | 'middle'>();
          buttons.add(input.button ?? 'left');
          this.heldButtons.set(id, buttons);
        } else if (input.phase === 'up') {
          await r.page.mouse.up({ button: input.button });
          this.heldButtons.get(id)?.delete(input.button ?? 'left');
        }
        return;
      case 'back':
        await r.page.goBack({ waitUntil: 'domcontentloaded' });
        return;
      case 'forward':
        await r.page.goForward({ waitUntil: 'domcontentloaded' });
        return;
      case 'reload':
        await r.page.reload({ waitUntil: 'domcontentloaded' });
        return;
      case 'text':
        await r.page.keyboard.insertText(string(input.text, 'text', 24000));
        return;
      case 'navigate':
        await r.page.goto(checkedURL(input.url), {
          waitUntil: 'domcontentloaded',
        });
        return;
      case 'dialog':
        return this.execute(
          'tab.dialogRespond',
          {
            tabId: id,
            runtimeId: this.options.runtimeId,
            dialogId: input.dialogId,
            accept: input.accept,
            text: input.text,
          },
          'human',
          'human',
        );
      default:
        throw new BrowserFault(
          'INVALID_REQUEST',
          'Unsupported viewer input.',
          'Refresh the Browser panel.',
        );
    }
  }
  private async exportContent(r: TabRecord, format: string) {
    if (format === 'pdf')
      return this.options.files.create(
        await r.page.pdf({ printBackground: true }),
        'application/pdf',
        'page.pdf',
        { tabId: r.info.id, url: sanitize(r.page.url()) },
      );
    if (format === 'text' || format === 'markdown') {
      const text = await r.page.locator('body').innerText();
      return this.options.files.create(
        Buffer.from(text),
        format === 'text' ? 'text/plain' : 'text/markdown',
        `page.${format === 'text' ? 'txt' : 'md'}`,
        { tabId: r.info.id, url: sanitize(r.page.url()) },
      );
    }
    if (format === 'html') {
      const snapshot = await this.dom(r.info.id);
      const html = snapshot.frames
        .map((f) => ('html' in f ? f.html : ''))
        .join('\n');
      return this.options.files.create(
        Buffer.from(html),
        'text/html',
        'page.html',
        { tabId: r.info.id, url: sanitize(r.page.url()) },
      );
    }
    throw new BrowserFault(
      'UNSUPPORTED_CAPABILITY',
      'Unsupported export format.',
      'Use text, markdown, html, or pdf.',
    );
  }
  private async assets(r: TabRecord) {
    const resources = await r.page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          'img[src],video[src],audio[src],source[src],link[rel=stylesheet][href]',
        ),
      )
        .slice(0, 200)
        .map((node) => ({
          tag: node.tagName,
          url:
            node instanceof HTMLLinkElement
              ? node.href
              : (node.getAttribute('src') ?? ''),
        })),
    );
    const urls = resources
      .map((v) => new URL(v.url, r.page.url()).href)
      .filter((url) => /^https?:/.test(url));
    const inventoryId = randomUUID();
    this.inventories.set(inventoryId, {
      tabId: r.info.id,
      documentId: r.info.documentId,
      urls,
    });
    while (this.inventories.size > 32)
      this.inventories.delete(this.inventories.keys().next().value!);
    return {
      inventoryId,
      tabId: r.info.id,
      documentId: r.info.documentId,
      assets: urls.map((url, index) => ({
        index,
        url: sanitize(url),
        origin: new URL(url).origin,
      })),
    };
  }
  private async bundle(r: TabRecord, id: string) {
    const inventory = this.inventories.get(id);
    if (
      !inventory ||
      inventory.tabId !== r.info.id ||
      inventory.documentId !== r.info.documentId
    )
      throw new BrowserFault(
        'STALE_REFERENCE',
        'The asset inventory is stale.',
        'Create a new asset inventory.',
      );
    const results = [];
    for (const url of inventory.urls.slice(0, 20)) {
      if (new URL(url).origin !== new URL(r.page.url()).origin) {
        results.push({
          url: sanitize(url),
          error: 'Cross-origin assets require a separate origin grant.',
        });
        continue;
      }
      try {
        const result = await r.page.evaluate(async (url) => {
          const response = await fetch(url, { credentials: 'same-origin' });
          const reader = response.body?.getReader();
          if (!reader) return { bytes: [], mime: 'application/octet-stream' };
          const bytes: number[] = [];
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (bytes.length + chunk.value.length > 2_000_000) {
              await reader.cancel();
              throw new Error('Asset exceeds the bundle limit.');
            }
            for (const byte of chunk.value) bytes.push(byte);
          }
          return {
            bytes,
            mime:
              response.headers.get('content-type') ??
              'application/octet-stream',
          };
        }, url);
        const artifact = await this.options.files.create(
          Buffer.from(result.bytes),
          result.mime,
          new URL(url).pathname.split('/').at(-1) || 'asset',
          { tabId: r.info.id, url: sanitize(url) },
        );
        results.push({ url: sanitize(url), artifact });
      } catch {
        results.push({ url: sanitize(url), error: 'Asset capture failed.' });
      }
    }
    return { inventoryId: id, results };
  }
  async close() {
    await this.context?.close();
    this.context = undefined;
  }
}
function checkedURL(url: string) {
  if (url === 'about:blank') return url;
  let value: URL;
  try {
    value = new URL(url);
  } catch {
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Invalid browser URL.',
      'Use an absolute HTTP or HTTPS URL.',
    );
  }
  if (
    !['http:', 'https:'].includes(value.protocol) ||
    value.username ||
    value.password
  )
    throw new BrowserFault(
      'ORIGIN_DENIED',
      'This URL scheme or credential format is blocked.',
      'Use an HTTP or HTTPS URL without embedded credentials.',
    );
  return value.href;
}
function sanitize(url: string) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}
async function fingerprint(handle: ElementHandle) {
  try {
    return await handle.evaluate((element) => {
      if (!(element instanceof Element) || !element.isConnected)
        return 'detached';
      return JSON.stringify({
        tag: element.tagName,
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        text: element.textContent?.slice(0, 500),
        type: element.getAttribute('type'),
        name: element.getAttribute('name'),
        href: element.getAttribute('href'),
        formaction: element.getAttribute('formaction'),
        labelledby: (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? ''),
        labels:
          element instanceof HTMLInputElement
            ? [...(element.labels ?? [])].map((label) => label.textContent)
            : [],
        disabled: element.hasAttribute('disabled'),
      });
    });
  } catch {
    return 'detached';
  }
}

function isLocator(value: Page | Locator | FrameLocator): value is Locator {
  return 'count' in value && typeof value.count === 'function';
}
