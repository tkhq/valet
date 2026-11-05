import type { BrowserContext, Page } from 'playwright-core';
import { browserPointerCursor, type BrowserPointerCursor } from '@valet/shared';

/** Native OS popups are absent from screenshots. Keep Chromium's in-page picker. */
export async function installViewerPage(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const roots = new WeakSet<Document | ShadowRoot>();
    const selects = new WeakSet<HTMLSelectElement>();
    const appearances = new WeakMap<HTMLSelectElement, { value: string; priority: string }>();
    const prepare = (target: HTMLSelectElement) => {
      // Preserve sites that already supply a customizable picker.
      if (!selects.has(target) && getComputedStyle(target).appearance === 'base-select') return;
      const root = target.getRootNode();
      if (!(root instanceof Document || root instanceof ShadowRoot)) return;
      if (!roots.has(root)) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(`
          select[data-valet-viewer-select],
          select[data-valet-viewer-select]::picker(select) {
            appearance: base-select !important;
          }
        `);
        // Constructed sheets also work under a page's strict style CSP.
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        roots.add(root);
      }
      const dropdown = !target.multiple && target.size <= 1;
      target.toggleAttribute('data-valet-viewer-select', dropdown);
      const previous = appearances.get(target);
      if (!dropdown && previous !== undefined) {
        appearances.delete(target);
        target.style.setProperty('appearance', previous.value, previous.priority);
      } else if (dropdown && getComputedStyle(target).appearance !== 'base-select') {
        appearances.set(target, { value: target.style.getPropertyValue('appearance'),
          priority: target.style.getPropertyPriority('appearance') });
        target.style.setProperty('appearance', 'base-select', 'important');
      }
      selects.add(target);
    };
    const observed = new WeakSet<Document | ShadowRoot>();
    const scan = (node: Node) => {
      const visit = (element: Element) => {
        if (element instanceof HTMLSelectElement) prepare(element);
        if (element.shadowRoot) observe(element.shadowRoot);
      };
      if (node instanceof Element) visit(node);
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      for (let element = walker.nextNode(); element; element = walker.nextNode())
        if (element instanceof Element) visit(element);
    };
    const observe = (root: Document | ShadowRoot) => {
      if (observed.has(root)) return;
      observed.add(root);
      new MutationObserver((records) => {
        const additions = new Set<Node>();
        for (const record of records) {
          if (record.type === 'attributes' && record.target instanceof HTMLSelectElement)
            prepare(record.target);
          for (const added of record.addedNodes) additions.add(added);
        }
        // The parser can report both an ancestor and its descendants in one batch.
        for (const added of additions) {
          if (!added.isConnected) continue;
          let ancestor = added.parentNode;
          while (ancestor && !additions.has(ancestor)) ancestor = ancestor.parentNode;
          if (!ancestor) scan(added);
        }
      }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['multiple', 'size', 'style'] });
      scan(root);
    };
    observe(document);
    // Also discover roots attached after their host enters the document.
    const discover = (event: Event) => {
      for (const target of event.composedPath()) {
        if (target instanceof ShadowRoot) observe(target);
        if (target instanceof HTMLSelectElement) prepare(target);
      }
    };
    for (const name of ['pointerover', 'pointerdown', 'focusin', 'keydown'])
      document.addEventListener(name, discover, true);
  });
}

/** Resolve viewport coordinates through frame borders, scaling and open shadow roots. */
export async function cursorAt(page: Page, x: number, y: number): Promise<BrowserPointerCursor> {
  let frame = page.mainFrame();
  let point = { x, y };
  for (let depth = 0; depth < 16; depth++) {
    const handle = await frame.evaluateHandle(({ x, y }) => {
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      return hit;
    }, point);
    try {
      const element = handle.asElement();
      if (!element) return 'default';
      const child = await element.contentFrame();
      if (child) {
        const box = await element.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          if (!(el instanceof HTMLElement)) return null;
          return { x: rect.x, y: rect.y, sx: rect.width / el.offsetWidth,
            sy: rect.height / el.offsetHeight, left: el.clientLeft, top: el.clientTop };
        });
        if (!box || !box.sx || !box.sy) return 'default';
        point = { x: (point.x - box.x) / box.sx - box.left,
          y: (point.y - box.y) / box.sy - box.top };
        frame = child;
        continue;
      }
      const value = await element.evaluate((el, { x, y }) => {
        const style = getComputedStyle(el);
        if (style.cursor !== 'auto') return style.cursor;
        if (el.closest('a[href],area[href]')) return 'pointer';
        if (el instanceof HTMLElement && el.isContentEditable) return 'text';
        if (el.matches('textarea,input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],input[type="password"],input[type="number"]'))
          return 'text';
        if (el.closest('button,select,option,input') || style.userSelect === 'none')
          return 'default';
        // A text cursor belongs over a glyph, not the whole containing block.
        const walker = document.createTreeWalker(el.shadowRoot ?? el, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let node = walker.nextNode();
        for (let count = 0; node && count < 512; count++, node = walker.nextNode()) {
          range.selectNodeContents(node);
          for (const rect of range.getClientRects())
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
              return style.writingMode.startsWith('vertical') ? 'vertical-text' : 'text';
        }
        return 'default';
      }, point);
      return browserPointerCursor(value);
    } finally {
      await handle.dispose();
    }
  }
  return 'default';
}
