import { readlink, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** Call only while holding owner.lock, before starting the browser. */
export async function clearRelocatedChromiumLocks(
  profile: string,
): Promise<void> {
  let owner: string;
  try {
    owner = await readlink(join(profile, 'SingletonLock'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  const match = /^(.*)-(\d+)$/.exec(owner);
  // A replaced sandbox has a new hostname. Its retained profile can still name
  // the old container after a forced stop. Chromium refuses that profile even
  // though this daemon holds its exclusive owner lock. Leave same-host and
  // unrecognized locks for Chromium to validate.
  if (!match || match[1] === hostname()) return;
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket'])
    await rm(join(profile, name), { force: true });
}
