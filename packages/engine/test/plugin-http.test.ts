import { describe, expect, it } from 'vitest';
import { validateValetPlugin } from '../src/valet-plugin.js';

const route = { id: 'status', method: 'GET', path: '/status', auth: 'public', maxBodyBytes: 0, handle: () => new Response('ok') };
const validate = (httpRoutes: unknown) => validateValetPlugin({ name: 'example', version: '1', httpRoutes });

describe('plugin HTTP declarations', () => {
  it('accepts portable handlers', () => {
    expect(validate([route]).ok).toBe(true);
  });
  it.each([
    { path: '/../org' }, { path: '/%2e%2e/org' }, { path: '/a//b' },
    { path: 'https://example.com' }, { path: '/a/*' }, { path: '/:id/:id' },
    { method: 'TRACE' }, { auth: 'optional' }, { maxBodyBytes: -1 },
    { maxBodyBytes: 1.5 }, { maxBodyBytes: 1024 * 1024 + 1 }, { handle: null },
    { auth: 'signature' },
  ])('rejects malformed route %j', (change) => {
    expect(validate([{ ...route, ...change }]).ok).toBe(false);
  });
  it('rejects duplicate IDs and ambiguous parameter routes', () => {
    expect(validate([route, { ...route, path: '/other' }]).ok).toBe(false);
    expect(validate([
      { ...route, path: '/items/:id' },
      { ...route, id: 'other', path: '/items/:name' },
    ]).ok).toBe(false);
    expect(validate([
      { ...route, path: '/items/:id' },
      { ...route, id: 'other', path: '/items/latest' },
    ]).ok).toBe(false);
  });
});
