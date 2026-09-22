import { describe, expect, it } from 'vitest';
import { staticNavItems } from './sidebar';

describe('sidebar navigation', () => {
  it('always exposes the personal usage page', () => {
    expect(staticNavItems).toContainEqual(expect.objectContaining({ href: '/settings/usage', label: 'Usage' }));
  });
});
