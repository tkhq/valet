import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserPointerCursor } from '@valet/shared';
import { cursorAt, installViewerPage } from '../src/viewer-page.js';

const installed = existsSync(chromium.executablePath());
if (!installed && process.env.VALET_BROWSER_REQUIRE_REAL === '1')
  throw Error('Pinned Chromium is missing. Run playwright-core install chromium.');
describe.skipIf(!installed)('viewer page behavior in Chromium', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch({ channel: 'chromium' }); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    context = await browser.newContext();
    await installViewerPage(context);
    page = await context.newPage();
    await page.goto('data:text/html,<title>Viewer fixture</title>');
  });
  afterEach(async () => { await context?.close(); });
  const load = (html: string) => page.goto('data:text/html,' + encodeURIComponent(html));

  it('renders dropdown options in the page and sends native selection events', async () => {
    await load(`<select aria-label="Color"><option>Red</option><optgroup label="More"><option disabled>Disabled</option><option>Blue</option></optgroup></select><output></output><script>const s=document.querySelector('select');for(const type of ['input','change'])s.addEventListener(type,e=>document.querySelector('output').textContent+=e.type+':'+e.isTrusted+';')</script>`);
    await page.getByLabel('Color').click();
    const blue = page.getByRole('option', { name: 'Blue' });
    const blueBox = await blue.boundingBox();
    expect(blueBox).not.toBeNull();
    if (!blueBox) throw Error('The option is absent from page rendering');
    const openPixels = await page.screenshot({ type: 'jpeg', clip: blueBox });
    await page.keyboard.press('Escape');
    expect(openPixels.equals(await page.screenshot({ type: 'jpeg', clip: blueBox }))).toBe(false);
    await page.getByLabel('Color').click();
    const disabled = await page.getByRole('option', { name: 'Disabled' }).boundingBox();
    if (!disabled) throw Error('The disabled option is absent');
    await page.mouse.click(disabled.x + 5, disabled.y + 5);
    expect(await page.getByLabel('Color').inputValue()).toBe('Red');
    await blue.click({ timeout: 2000 });
    expect(await page.getByLabel('Color').inputValue()).toBe('Blue');
    expect(await page.locator('output').textContent()).toBe('input:true;change:true;');
    await page.getByLabel('Color').press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    expect(await page.getByLabel('Color').inputValue()).toBe('Red');
  });

  it('supports dynamic shadow dropdowns and preserves authored custom dropdowns', async () => {
    await load('<div id="host"></div><button aria-haspopup="listbox">Custom</button>');
    await page.locator('#host').evaluate(el => {
      el.attachShadow({mode:'open'}).innerHTML='<select aria-label="Shadow"><option>One</option><option>Two</option></select>';
    });
    await page.getByLabel('Shadow').click();
    expect(await page.getByRole('option', {name:'Two'}).boundingBox()).not.toBeNull();
    await page.getByRole('option', {name:'Two'}).click({timeout:2000});
    expect(await page.getByLabel('Shadow').inputValue()).toBe('Two');
    expect(await page.getByRole('button').evaluate(el=>getComputedStyle(el).appearance)).toBe('auto');
  });

  it('supports dropdowns inside child frames', async () => {
    await load('<iframe srcdoc="<select><option>First</option><option>Second</option></select>"></iframe>');
    const frame = page.frameLocator('iframe');
    await frame.locator('select').click();
    expect(await frame.getByRole('option',{name:'Second'}).boundingBox()).not.toBeNull();
    await frame.getByRole('option',{name:'Second'}).click({timeout:2000});
    expect(await frame.locator('select').inputValue()).toBe('Second');
  });

  it('resolves text, links, authored cursors, shadow roots and frame coordinates', async () => {
    await load('<a href="#">Link</a><input aria-label="Name"><button style="cursor:wait">Wait</button><div id="shadow"></div><iframe style="width:200px;height:100px;transform:scale(.8);transform-origin:top left" srcdoc="<input aria-label=Inner>"></iframe>');
    await page.locator('#shadow').evaluate(el=>{el.attachShadow({mode:'open'}).innerHTML='<button style="cursor:grab">Grab</button>';});
    for (const [locator, expected] of [
      [page.getByRole('link'), 'pointer'],
      [page.getByLabel('Name'), 'text'],
      [page.getByRole('button',{name:'Wait'}), 'wait'],
      [page.getByRole('button',{name:'Grab'}), 'grab'],
      [page.frameLocator('iframe').getByLabel('Inner'), 'text'],
    ] as const) {
      const box = await locator.boundingBox();
      if (!box) throw Error('Missing fixture control');
      expect(await cursorAt(page, box.x+5, box.y+5)).toBe(expected);
    }
    expect(await cursorAt(page, 900, 600)).toBe('default');
  });
  it('keeps listboxes native and handles size changes under strict CSP', async () => {
    await load(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'none'"><select size="1"><option>First</option><option>Second</option></select>`);
    const select = page.locator('select');
    await select.click();
    expect(await page.getByRole('option', {name:'Second'}).boundingBox()).not.toBeNull();
    await page.keyboard.press('Escape');
    await select.evaluate(el => { el.size = 4; });
    await expect.poll(() => select.evaluate(el => getComputedStyle(el).appearance)).toBe('auto');
    await select.evaluate(el => { el.size = 0; });
    await expect.poll(() => select.evaluate(el => getComputedStyle(el).appearance)).toBe('base-select');
    await select.evaluate(el => { el.multiple = true; });
    await expect.poll(() => select.evaluate(el => getComputedStyle(el).appearance)).toBe('auto');
  });

  it('supports a long dropdown and outside-click cancellation', async () => {
    await load('<select>' + Array.from({length:100}, (_,i)=>`<option>Choice ${i}</option>`).join('') + '</select>');
    await page.locator('select').click();
    await page.mouse.click(500, 500);
    expect(await page.locator('select').evaluate(el=>el.matches(':open'))).toBe(false);
    await page.locator('select').press('Space');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    expect(await page.locator('select').inputValue()).toBe('Choice 99');
  });

  it('resolves text glyphs without turning blank areas into text cursors', async () => {
    await load('<p style="width:600px;height:80px">Some text</p><p style="cursor:ew-resize">Resize</p>');
    const box = await page.locator('p').first().boundingBox();
    if (!box) throw Error('Missing text fixture');
    expect(await cursorAt(page,box.x+3,box.y+8)).toBe('text');
    expect(await cursorAt(page,box.x+550,box.y+8)).toBe('default');
    await page.locator('p').first().evaluate(el=>{ el.textContent=''; el.attachShadow({mode:'open'}).innerHTML='<span style="font:32px monospace">MMMM</span>'; });
    const glyphs = await page.locator('p span').boundingBox();
    if (!glyphs) throw Error('Missing shadow text fixture');
    for (let x=3;x<glyphs.width-2;x+=3)
      expect(await cursorAt(page,glyphs.x+x,glyphs.y+10)).toBe('text');
    await page.locator('p').first().evaluate(el=>{ if(el.shadowRoot) el.shadowRoot.innerHTML='MMMM'; });
    expect(await cursorAt(page,box.x+3,box.y+8)).toBe('text');
    const resize = await page.getByText('Resize').boundingBox();
    if (!resize) throw Error('Missing resize fixture');
    expect(await cursorAt(page,resize.x+3,resize.y+8)).toBe('ew-resize');
  });

  it('uses keyword fallbacks for custom cursor URLs', () => {
    expect(browserPointerCursor('url("https://site/cursor.png"), crosshair')).toBe('crosshair');
    expect(browserPointerCursor('url("https://site/cursor.png")')).toBe('default');
    expect(browserPointerCursor('unrecognized')).toBe('default');
  });

  it('renders a picker opened by another control and after a move into shadow DOM', async () => {
    await load(`<button onclick="document.querySelector('select').showPicker()">Open</button><select><option>First</option><option>Second</option></select><div id="host"></div>`);
    await page.getByRole('button',{name:'Open'}).click();
    expect(await page.getByRole('option',{name:'Second'}).boundingBox()).not.toBeNull();
    await page.keyboard.press('Escape');
    await page.locator('#host').evaluate(el => {
      const select = document.querySelector('select');
      if (select) el.attachShadow({mode:'open'}).appendChild(select);
    });
    await page.locator('select').click();
    expect(await page.getByRole('option',{name:'Second'}).boundingBox()).not.toBeNull();
  });

  it('overrides an important native appearance and restores it for listboxes', async () => {
    await load('<select style="appearance:none !important"><option>First</option><option>Second</option></select>');
    await page.locator('select').click();
    expect(await page.getByRole('option',{name:'Second'}).boundingBox()).not.toBeNull();
    await page.keyboard.press('Escape');
    await page.locator('select').evaluate(el=>{el.multiple=true;});
    await expect.poll(()=>page.locator('select').evaluate(el=>getComputedStyle(el).appearance)).toBe('none');
    await load('<style>#choice { appearance:none !important }</style><select id="choice"><option>First</option><option>Second</option></select>');
    await page.locator('select').click();
    expect(await page.getByRole('option',{name:'Second'}).boundingBox()).not.toBeNull();
  });

  it('supports cross-origin framed dropdowns and cursor coordinates', async () => {
    await context.route(/^http:\/\/(outer|inner)\.viewer\.test\//, route => route.fulfill({
      contentType:'text/html',
      body: route.request().url().includes('outer')
        ? '<iframe style="border:10px solid;transform:scale(.8);transform-origin:top left" src="http://inner.viewer.test/"></iframe>'
        : '<select><option>First</option><option>Second</option></select><button style="cursor:zoom-in">Zoom</button>',
    }));
    await page.goto('http://outer.viewer.test/');
    const child = page.frameLocator('iframe');
    await child.locator('select').click();
    const option = await child.getByRole('option',{name:'Second'}).boundingBox();
    if (!option) throw Error('The cross-origin option is absent');
    await page.mouse.click(option.x+5, option.y+5);
    expect(await child.locator('select').inputValue()).toBe('Second');
    const button = await child.getByRole('button').boundingBox();
    if (!button) throw Error('The frame button is absent');
    expect(await cursorAt(page,button.x+5,button.y+5)).toBe('zoom-in');
  });

});
