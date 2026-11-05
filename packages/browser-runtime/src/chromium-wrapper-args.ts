import { dirname, join } from 'node:path';

/**
 * Chrome for Testing reads its managed policy from this directory. The
 * confined namespace has no /etc, so the launcher binds this one path.
 */
export const CHROMIUM_POLICY_DIR =
  '/etc/opt/chrome_for_testing/policies/managed';

export interface BwrapArgsInput {
  state: string;
  root: string;
  executable: string;
  execPath: string;
  arch: string;
  argv: string[];
  policyDirExists: boolean;
}

export function buildBwrapArgs(input: BwrapArgsInput): string[] {
  const { state, root, executable, execPath, arch, argv, policyDirExists } =
    input;
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
  ...(policyDirExists
    ? ['--ro-bind', CHROMIUM_POLICY_DIR, CHROMIUM_POLICY_DIR]
    : []),
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
  execPath,
  join(root, 'dist', 'namespace-proxy.js'),
  ...argv,
];
if (arch === 'x64') args.unshift('--symlink', 'usr/lib64', '/lib64');
  return args;
}
