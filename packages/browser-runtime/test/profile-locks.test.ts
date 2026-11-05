import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRelocatedChromiumLocks } from '../src/profile-locks.js';

let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'browser-profile-locks-'));
});
afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

it('clears old container locks without changing the retained profile', async () => {
  await symlink('previous-container-226', join(profile, 'SingletonLock'));
  await symlink('123456', join(profile, 'SingletonCookie'));
  await symlink(
    '/tmp/old-chromium/SingletonSocket',
    join(profile, 'SingletonSocket'),
  );
  await writeFile(join(profile, 'Cookies'), 'retained cookies');
  await clearRelocatedChromiumLocks(profile);
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket'])
    await expect(readlink(join(profile, name))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  expect(await readFile(join(profile, 'Cookies'), 'utf8')).toBe(
    'retained cookies',
  );
});

it('leaves same-host locks for Chromium to validate', async () => {
  const owner = `${hostname()}-${process.pid}`;
  await symlink(owner, join(profile, 'SingletonLock'));
  await symlink('123456', join(profile, 'SingletonCookie'));
  await clearRelocatedChromiumLocks(profile);
  expect(await readlink(join(profile, 'SingletonLock'))).toBe(owner);
  expect(await readlink(join(profile, 'SingletonCookie'))).toBe('123456');
});

it('accepts a fresh profile without locks', async () => {
  await expect(clearRelocatedChromiumLocks(profile)).resolves.toBeUndefined();
});
