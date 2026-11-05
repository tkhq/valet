import { expect, it } from 'vitest';
import { immutableDocument } from '../src/repl/dom.js';
it('supports maintained CSS selection without exposing mutation or browser globals', () => {
  const document = immutableDocument(
    '<html><body><h1>Visible</h1><input type="password"><button data-testid="save">Save</button><valet-shadow-root><span>Shadow</span></valet-shadow-root></body></html>',
  );
  expect(document.querySelector('[data-testid="save"]')?.textContent).toBe(
    'Save',
  );
  expect(document.querySelectorAll('span').map((n) => n.textContent)).toEqual([
    'Shadow',
  ]);
  expect(() => Reflect.set(document, 'cookie', 'secret')).toThrow();
  expect(() => Reflect.get(document, 'createElement')).toThrow(/unsupported/i);
  const node = document.querySelector('h1');
  expect(() => Reflect.set(node!, 'textContent', 'Changed')).toThrow();
  expect(document.querySelector('h1')?.textContent).toBe('Visible');
});
