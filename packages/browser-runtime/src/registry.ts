import type { BrowserOperationClass } from '@valet/shared';
import { BrowserFault } from './protocol.js';
const groups: Record<BrowserOperationClass, string[]> = {
  observation: [
    'tabs.list',
    'tabs.get',
    'tabs.selected',
    'browser.documentation',
    'tab.title',
    'tab.url',
    'tab.getAXState',
    'tab.getScreenshot',
    'tab.getAXStateAndScreenshot',
    'tab.domSnapshot',
    'tab.getJsDialog',
    'tab.assets',
    'tab.clipboardRead',
    'tab.webmcpList',
    'tab.waitForURL',
    'tab.waitForLoadState',
    'locator.count',
    'locator.textContent',
    'locator.innerText',
    'locator.allTextContents',
    'locator.getAttribute',
    'locator.isVisible',
    'locator.isEnabled',
    'locator.waitFor',
  ],
  navigation: ['tabs.new', 'tab.goto', 'tab.back', 'tab.forward', 'tab.reload'],
  mutation: [
    'tab.close',
    'tab.markDeliverable',
    'tab.markHandoff',
    'tab.click',
    'tab.hover',
    'tab.drag',
    'tab.scroll',
    'tab.setValue',
    'tab.selectText',
    'tab.performSecondaryAction',
    'tab.typeText',
    'tab.paste',
    'tab.pressKey',
    'tab.clipboardWrite',
    'tab.dialogRespond',
    'locator.click',
    'locator.dblclick',
    'locator.hover',
    'locator.fill',
    'locator.type',
    'locator.pressSequentially',
    'locator.press',
    'locator.check',
    'locator.uncheck',
    'locator.setChecked',
    'locator.selectOption',
  ],
  upload: ['tab.upload'],
  page_tool: ['tab.webmcpCall'],
  export: ['tab.export', 'tab.bundleAssets', 'browser.downloads'],
  history: ['browser.history'],
  diagnostic: ['tab.logs', 'tab.network'],
};
export const METHOD_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(groups).flatMap(([operationClass, methods]) =>
      methods.map((method) => [
        method,
        { operationClass: operationClass as BrowserOperationClass },
      ]),
    ),
  ),
);
export function methodClass(method: string): BrowserOperationClass {
  const entry = METHOD_REGISTRY[method];
  if (!entry)
    throw new BrowserFault(
      'UNSUPPORTED_CAPABILITY',
      `Browser method ${method} is unavailable.`,
      'Read browser.describe for the supported methods.',
    );
  return entry.operationClass;
}
export function documentation() {
  const examples = [
    'Start a page and inspect its controls:',
    'const tab = await browser.tabs.new({url: "http://localhost:5173"});',
    'await tab.getAXState();',
    '',
    'Bindings remain available in later cells:',
    'await tab.playwright.getByLabel("Name", {exact:true}).fill("Ada");',
    'await tab.playwright.getByRole("button", {name:"Save", exact:true}).hover();',
    'await tab.playwright.getByRole("button", {name:"Save", exact:true}).click();',
    'await tab.getScreenshot({emit:false});',
    'await tab.scroll({x:640, y:400, deltaY:800});',
    'await tab.getAXState();',
    'await tab.getScreenshot();',
    '',
    'List existing tabs, then select one by its returned ID:',
    'output.write(await browser.tabs.list());',
    'const existing = await browser.tabs.get("RETURNED_TAB_ID");',
    'output.write(await existing.title());',
    '',
    'Read a detached DOM observation. Live page globals are unavailable:',
    'output.write(await tab.playwright.evaluate(() => document.querySelector("h1")?.textContent));',
    '',
    'Keep a result tab after the current turn:',
    'await tab.markDeliverable();',
    '',
    'Export rendered content through the artifact broker:',
    'await tab.content.export("text");',
  ].join('\n');
  return `Browser protocol 1.0. Persistent Node REPL bindings support top-level await. Lexical redeclarations fail; use a fresh variable name or reuse an existing binding. Use browser.reset only when you need to discard all bindings. Observation methods emit by default and also return their text. Use {emit:false} to return without emitting. Use output.write for other reads. Locators are strict. People and agents share normal input. References expire after navigation, replacement, reset, or human input. Keep an observation and its reference action in one cell when possible. An explicit pause blocks agent mutations until the user resumes shared use. Coordinates use viewport CSS pixels. evaluate reads an immutable snapshot and cannot access live page globals. Approval waits preserve the cell. Never repeat a failed mutation before checking its receipt and the page.\n\n${examples}\n\nAvailable methods:\n${Object.entries(
    METHOD_REGISTRY,
  )
    .map(([name, meta]) => `${name}: ${meta.operationClass}`)
    .join('\n')}`;
}
