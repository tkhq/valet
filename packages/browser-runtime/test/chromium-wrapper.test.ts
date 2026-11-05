import { expect, it } from 'vitest';
import {
  buildBwrapArgs,
  CHROMIUM_POLICY_DIR,
} from '../src/chromium-wrapper-args.js';

const input = {
  state: '/var/lib/valet/browser',
  root: '/opt/valet/browser',
  executable: '/opt/pw/chromium-1/chrome-linux/chrome',
  execPath: '/usr/local/bin/node',
  arch: 'x64',
  argv: ['--flag'],
  policyDirExists: true,
};

it('binds only the Chromium managed policy directory read-only when it exists', () => {
  const args = buildBwrapArgs(input);
  const i = args.indexOf(CHROMIUM_POLICY_DIR);
  expect(i).toBeGreaterThan(1);
  expect(args.slice(i - 1, i + 2)).toEqual([
    '--ro-bind',
    CHROMIUM_POLICY_DIR,
    CHROMIUM_POLICY_DIR,
  ]);
  expect(args).not.toContain('/etc');
  expect(args.filter((a) => a.startsWith('/etc'))).toHaveLength(2);
});

it('omits the policy bind when the directory is absent', () => {
  const args = buildBwrapArgs({ ...input, policyDirExists: false });
  expect(args.some((a) => a.startsWith('/etc'))).toBe(false);
});
