import { expect, it } from 'vitest';
import { createFacade } from '../src/repl/facade.js';
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
