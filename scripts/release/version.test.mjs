import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from './version.mjs';

test('increments each stable version component', () => {
  const tags = ['valet/v0.9.9', 'valet/v0.10.2', 'chart/valet-v99.0.0', 'valet/v9.0.0-rc.1', 'valet-dev', 'v99.0.0', 'other/v99.0.0'];
  assert.equal(nextVersion(tags, 'patch'), 'valet/v0.10.3');
  assert.equal(nextVersion(tags, 'minor'), 'valet/v0.11.0');
  assert.equal(nextVersion(tags, 'major'), 'valet/v1.0.0');
});
test('starts with zero and rejects invalid bumps', () => {
  assert.equal(nextVersion([], 'patch'), 'valet/v0.0.1');
  assert.equal(nextVersion(['v0.3.5', 'chart/valet-v9.0.0'], 'minor'), 'valet/v0.1.0');
  assert.throws(() => nextVersion([], 'other'), /Choose major, minor, or patch/);
});

test('finds the preceding application release when retrying an older run', async () => {
  const { previousVersion } = await import('./version.mjs');
  assert.equal(previousVersion(['valet/v0.3.5', 'valet/v0.4.0', 'valet/v0.5.0', 'chart/valet-v0.3.9'], 'valet/v0.4.0'), 'valet/v0.3.5');
  assert.equal(previousVersion(['valet/v0.4.0'], 'valet/v0.4.0'), '');
});
