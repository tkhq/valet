/** Trusted launcher. Playwright's native protocol stays on inherited pipes 3 and 4. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  buildBwrapArgs,
  CHROMIUM_POLICY_DIR,
} from './chromium-wrapper-args.js';
const state = process.env.VALET_BROWSER_STATE,
  root = process.env.VALET_BROWSER_ROOT,
  executable = process.env.VALET_CHROMIUM_EXECUTABLE;
if (!state || !root || !executable)
  throw new Error(
    'Browser launcher configuration is missing. Rebuild the sandbox image.',
  );
const args = buildBwrapArgs({
  state,
  root,
  executable,
  execPath: process.execPath,
  arch: process.arch,
  argv: process.argv.slice(2),
  policyDirExists: existsSync(CHROMIUM_POLICY_DIR),
});
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
