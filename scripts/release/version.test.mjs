import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from './version.mjs';

test('increments each stable version component', () => {
  const tags = ['v0.9.9', 'v0.10.2', 'chart/valet-v99.0.0', 'v9.0.0-rc.1', 'valet-dev'];
  assert.equal(nextVersion(tags, 'patch'), 'v0.10.3');
  assert.equal(nextVersion(tags, 'minor'), 'v0.11.0');
  assert.equal(nextVersion(tags, 'major'), 'v1.0.0');
});
test('starts with zero and rejects invalid bumps', () => {
  assert.equal(nextVersion([], 'patch'), 'v0.0.1');
  assert.throws(() => nextVersion([], 'other'), /Choose major, minor, or patch/);
});

test('finds the preceding application release when retrying an older run', async () => {
  const { previousVersion } = await import('./version.mjs');
  assert.equal(previousVersion(['v0.3.5', 'v0.4.0', 'v0.5.0', 'chart/valet-v0.3.9'], 'v0.4.0'), 'v0.3.5');
  assert.equal(previousVersion(['v0.4.0'], 'v0.4.0'), '');
});
