import { immutableDocument } from './dom.js';
import type {
  BrowserLocator,
  BrowserLocatorStep,
  BrowserTabInfo,
} from '@valet/shared';
type Rpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
export function createFacade(rpc: Rpc) {
  const references = new Map<string, Map<string, object>>();
  const locator = (query: BrowserLocator): object => {
    const chain = (step: BrowserLocatorStep) =>
      locator({ ...query, steps: [...query.steps, step] });
    const methods: Record<string, unknown> = {
      getByRole: (
        role: string,
        options: { name?: string; exact?: boolean } = {},
      ) => chain({ kind: 'role', value: role, ...options }),
      getByLabel: (value: string, options = {}) =>
        chain({ kind: 'label', value, ...options }),
      getByPlaceholder: (value: string, options = {}) =>
        chain({ kind: 'placeholder', value, ...options }),
      getByText: (value: string, options = {}) =>
        chain({ kind: 'text', value, ...options }),
      getByTestId: (value: string) => chain({ kind: 'testId', value }),
      locator: (value: string) => chain({ kind: 'css', value }),
      frameLocator: (value: string) => chain({ kind: 'frame', value }),
      first: () => chain({ kind: 'first' }),
      last: () => chain({ kind: 'last' }),
      nth: (index: number) => chain({ kind: 'nth', index }),
      filter: (options: {
        hasText?: string;
        hasNotText?: string;
        visible?: boolean;
      }) => chain({ kind: 'filter', ...options }),
      all: async () =>
        Array.from(
          { length: Number(await rpc('locator.count', { locator: query })) },
          (_, index) => chain({ kind: 'nth', index }),
        ),
    };
    for (const action of [
      'count',
      'textContent',
      'innerText',
      'allTextContents',
      'getAttribute',
      'isVisible',
      'isEnabled',
      'hover',
      'click',
      'dblclick',
      'fill',
      'type',
      'pressSequentially',
      'press',
      'check',
      'uncheck',
      'setChecked',
      'selectOption',
      'waitFor',
    ])
      methods[action] = (...args: unknown[]) =>
        rpc(`locator.${action}`, { locator: query, args });
    methods.domSnapshot = () =>
      rpc('tab.domSnapshot', {
        tabId: query.tabId,
        runtimeId: query.runtimeId,
      });
    methods.evaluate = async (
      fn: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => {
      if (typeof fn !== 'function')
        throw Error(
          'evaluate requires a function. It reads an immutable DOM snapshot.',
        );
      const snapshot = await rpc('tab.domSnapshot', {
        tabId: query.tabId,
        runtimeId: query.runtimeId,
      });
      if (!snapshot || typeof snapshot !== 'object')
        throw Error(
          'The DOM snapshot is unavailable. Take a fresh observation.',
        );
      const frames: unknown = Reflect.get(snapshot, 'frames');
      const first = Array.isArray(frames) ? frames[0] : undefined;
      if (!first || typeof first.html !== 'string')
        throw Error('The selected frame snapshot is unavailable.');
      const document = immutableDocument(first.html);
      // Source executes only in this confined child. It never reaches Playwright evaluate.
      const run = new Function(
        'document',
        'args',
        `"use strict";return (${fn.toString()})(...args);`,
      );
      const value: unknown = await run(document, args);
      return { snapshotId: Reflect.get(snapshot, 'snapshotId'), value };
    };
    Object.defineProperty(methods, '__query', { value: query });
    for (const kind of ['and', 'or'] as const)
      methods[kind] = (other: object) =>
        chain({
          kind,
          locator: Reflect.get(other, '__query') as BrowserLocator,
        });
    return Object.freeze(methods);
  };
  const tab = (info: BrowserTabInfo): object => {
    const target = (value: unknown): unknown => {
      const id =
        typeof value === 'string'
          ? value
          : value &&
              typeof value === 'object' &&
              typeof Reflect.get(value, 'id') === 'string'
            ? String(Reflect.get(value, 'id'))
            : undefined;
      return id ? (references.get(info.id)?.get(id) ?? { id }) : value;
    };
    const remember = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const refs: unknown = Reflect.get(value, 'refs');
      if (!Array.isArray(refs)) return;
      references.set(
        info.id,
        new Map(
          refs
            .filter((ref): ref is object =>
              Boolean(
                ref &&
                typeof ref === 'object' &&
                typeof Reflect.get(ref, 'id') === 'string',
              ),
            )
            .map((ref) => [String(Reflect.get(ref, 'id')), ref]),
        ),
      );
    };
    const call = (method: string, params: Record<string, unknown> = {}) =>
      rpc(`tab.${method}`, {
        tabId: info.id,
        runtimeId: info.runtimeId,
        ...params,
      });
    const methods: Record<string, unknown> = {
      id: info.id,
      playwright: locator({
        tabId: info.id,
        runtimeId: info.runtimeId,
        steps: [],
      }),
    };
    for (const method of [
      'back',
      'forward',
      'reload',
      'close',
      'title',
      'url',
      'getJsDialog',
      'markDeliverable',
      'markHandoff',
    ])
      methods[method] = () => call(method);
    methods.goto = (url: string) => call('goto', { url });
    for (const method of [
      'getAXState',
      'getScreenshot',
      'getAXStateAndScreenshot',
      'domSnapshot',
    ])
      methods[method] = async (options = {}) => {
        const result = await call(method, { options });
        if (method === 'getAXState') {
          remember(result);
          return result && typeof result === 'object'
            ? Reflect.get(result, 'text')
            : result;
        }
        if (
          method === 'getAXStateAndScreenshot' &&
          result &&
          typeof result === 'object'
        )
          remember(Reflect.get(result, 'observation'));
        return result;
      };
    for (const method of [
      'click',
      'hover',
      'scroll',
      'setValue',
      'selectText',
      'performSecondaryAction',
      'typeText',
      'paste',
      'pressKey',
      'drag',
    ])
      methods[method] = (...args: unknown[]) =>
        call(method, {
          args: args.length ? [target(args[0]), ...args.slice(1)] : args,
        });
    methods.waitForURL = (url: string, options = {}) =>
      call('waitForURL', { url, options });
    methods.waitForLoadState = (state = 'domcontentloaded') =>
      call('waitForLoadState', { state });
    methods.content = Object.freeze({
      export: (format: string) => call('export', { format }),
      assets: () => call('assets'),
      bundleAssets: (inventoryId: string) =>
        call('bundleAssets', { inventoryId }),
    });
    methods.dev = Object.freeze({
      logs: () => call('logs'),
      network: () => call('network'),
    });
    methods.clipboard = Object.freeze({
      read: () => call('clipboardRead'),
      write: (text: string) => call('clipboardWrite', { text }),
    });
    methods.dialog = Object.freeze({
      respond: (dialogId: string, accept: boolean, text?: string) =>
        call('dialogRespond', { dialogId, accept, text }),
    });
    methods.webmcp = Object.freeze({
      list: () => call('webmcpList'),
      call: (toolId: string, args: unknown) =>
        call('webmcpCall', { toolId, args }),
    });
    methods.upload = (target: unknown, paths: string[]) =>
      call('upload', {
        target:
          typeof target === 'string'
            ? (references.get(info.id)?.get(target) ?? { id: target })
            : target,
        paths,
      });
    return Object.freeze(methods);
  };
  return Object.freeze({
    tabs: Object.freeze({
      list: () => rpc('tabs.list', {}),
      new: async (options = {}) =>
        tab((await rpc('tabs.new', options)) as BrowserTabInfo),
      get: async (id: string) =>
        tab((await rpc('tabs.get', { id })) as BrowserTabInfo),
      selected: async () => {
        const info = await rpc('tabs.selected', {});
        return info ? tab(info as BrowserTabInfo) : undefined;
      },
    }),
    history: (options = {}) => rpc('browser.history', options),
    documentation: (topic?: string) => rpc('browser.documentation', { topic }),
    downloads: () => rpc('browser.downloads', {}),
  });
}
