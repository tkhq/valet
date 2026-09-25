import { expect, it } from 'vitest';
import { createFacade } from '../src/repl/facade.js';
import { FACADE_METHOD_NAMES } from '../src/registry.js';
it('resolves an observed opaque reference into its full wire identity', async () => {
  const ref = {
    id: 'opaque',
    runtimeId: 'runtime',
    tabId: 'tab',
    documentId: 'document',
    snapshotId: 'snapshot',
    frameId: 'main',
  };
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const browser = createFacade(async (method, params) => {
    requests.push({ method, params });
    if (method === 'tabs.get') return { id: 'tab', runtimeId: 'runtime' };
    if (method === 'tab.getAXState')
      return { text: 'button Save [ref=opaque]', refs: [ref] };
    return undefined;
  });
  const tab = await browser.tabs.get('tab');
  expect(await Reflect.get(tab, 'getAXState')()).toBe(
    'button Save [ref=opaque]',
  );
  await Reflect.get(tab, 'click')('opaque');
  expect(requests.at(-1)?.params.args).toEqual([ref]);
});

it('exposes semantic hover through the RPC facade', async () => {
  const requests: string[] = [];
  const browser = createFacade(async (method) => {
    requests.push(method);
    if (method === 'tabs.get') return { id: 'tab', runtimeId: 'runtime' };
    return undefined;
  });
  const tab = await browser.tabs.get('tab');
  const locator = Reflect.get(tab, 'playwright').getByRole('button', {
    name: 'Save',
  });
  expect(typeof locator.hover).toBe('function');
  await locator.hover();
  expect(requests.at(-1)).toBe('locator.hover');
});

it('documents methods that exist on the REPL facade', async () => {
  const browser = createFacade(async (method) =>
    method === 'tabs.get' ? { id: 'tab', runtimeId: 'runtime' } : undefined,
  );
  const tab = await browser.tabs.get('tab');
  for (const name of Object.values(FACADE_METHOD_NAMES)) {
    const [, ...parts] = name.split('.');
    let target: unknown = tab;
    for (const part of parts) target = Reflect.get(target as object, part);
    expect(typeof target, name).toBe('function');
  }
});
