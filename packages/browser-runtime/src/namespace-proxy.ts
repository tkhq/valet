import { createNamespaceProxy } from './proxy.js';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const state = process.env.VALET_BROWSER_STATE,
  executable = process.env.VALET_CHROMIUM_EXECUTABLE;
if (!state || !executable)
  throw Error('Missing proxy configuration. Rebuild the sandbox image.');
const proxy = createNamespaceProxy(join(state, 'broker.sock'));
proxy.listen(8877, '127.0.0.1', () => {
  const child = spawn(executable!, process.argv.slice(2), {
    stdio: ['ignore', 'inherit', 'inherit', 3, 4],
    env: {
      HOME: state!,
      XDG_CONFIG_HOME: join(state!, 'config'),
      XDG_CACHE_HOME: join(state!, 'cache'),
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
  });
  child.on('exit', (code) => {
    proxy.close();
    process.exit(code ?? 1);
  });
  child.on('error', () => process.exit(1));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, () => child.kill(signal));
});
