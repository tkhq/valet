/** Trusted launcher. Playwright's native protocol stays on inherited pipes 3 and 4. */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
const state = process.env.VALET_BROWSER_STATE,
  root = process.env.VALET_BROWSER_ROOT,
  executable = process.env.VALET_CHROMIUM_EXECUTABLE;
if (!state || !root || !executable)
  throw new Error(
    'Browser launcher configuration is missing. Rebuild the sandbox image.',
  );
const args = [
  '--unshare-user',
  '--unshare-net',
  '--unshare-ipc',
  '--unshare-uts',
  '--die-with-parent',
  '--ro-bind',
  '/usr',
  '/usr',
  '--symlink',
  'usr/lib',
  '/lib',
  '--ro-bind',
  root,
  root,
  '--ro-bind',
  dirname(dirname(executable)),
  dirname(dirname(executable)),
  '--bind',
  '/proc',
  '/proc',
  '--dev',
  '/dev',
  '--tmpfs',
  '/tmp',
  '--bind',
  state,
  state,
  '--clearenv',
  '--setenv',
  'HOME',
  state,
  '--setenv',
  'XDG_CONFIG_HOME',
  join(state, 'config'),
  '--setenv',
  'XDG_CACHE_HOME',
  join(state, 'cache'),
  '--setenv',
  'VALET_BROWSER_STATE',
  state,
  '--setenv',
  'VALET_CHROMIUM_EXECUTABLE',
  executable,
  process.execPath,
  join(root, 'dist', 'namespace-proxy.js'),
  ...process.argv.slice(2),
];
if (process.arch === 'x64') args.unshift('--symlink', 'usr/lib64', '/lib64');
const child = spawn('/usr/bin/bwrap', args, {
  stdio: ['ignore', 'inherit', 'inherit', 3, 4],
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
child.on('error', (error) => {
  process.stderr.write(error.message);
  process.exit(1);
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => child.kill(signal));
