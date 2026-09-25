import { chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BrowserFault } from './protocol.js';
/** Some provider bind filesystems cannot chmod socket inodes. The private parent still enforces access. */
export async function secureSocket(path: string, mode: number) {
  try {
    await chmod(path, mode);
  } catch (error) {
    const code =
      error && typeof error === 'object'
        ? Reflect.get(error, 'code')
        : undefined;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
    const parent = await stat(dirname(path));
    if (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
      throw new BrowserFault(
        'BROWSER_UNAVAILABLE',
        'The browser socket parent is not private.',
        'Set the browser state directory owner and mode to the daemon UID and 0700.',
      );
  }
}
