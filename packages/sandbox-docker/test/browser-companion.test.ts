import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerInventory, dockerOwnerLabels, validateDockerOwner, validateDockerBrowserOwner, type DockerInventoryRecord } from '../src/inventory.js';
import { DockerSandbox } from '../src/sandbox.js';
import { buildBrowserCompanionArgs } from '../src/browser-companion.js';

const companion = { containerName: 'browser-owner', containerId: 'browser-id', image: 'stock:browser', imageId: 'sha256:browser', networkOwnerId: 'workload-id' };
function record(root = '/private'): DockerInventoryRecord {
  return { version: 1, id: 'dsb-session', sessionId: 'session', providerId: 'daemon', containerName: 'workload-owner', containerId: 'workload-id', image: 'repo:bake', imageId: 'sha256:workload', workspace: '/work', runtimeStateDir: join(root, 'state/dsb-session'), docker: true, browser: { enabled: true }, browserCompanion: { ...companion }, state: 'running' };
}

describe('browser companion arguments and ownership', () => {
  it('shares the workload network and a read-only upload view with a confined stock browser container', async () => {
    const args = buildBrowserCompanionArgs({ owner: record(), seccompProfile: '/profiles/browser.json', uid: 501, gid: 20 });
    expect(args).toEqual(expect.arrayContaining(['--network', 'container:workload-id', '--security-opt', 'seccomp=/profiles/browser.json', '-v', '/private/state/dsb-session:/var/lib/valet']));
    expect(args.filter(arg => arg === '-v')).toHaveLength(2);
    expect(args).toContain('/work:/workspace:ro');
    expect(args).toContain('VALET_BROWSER_WORKSPACE_READONLY=1');
    expect(args).toContain('stock:browser');
    expect(args).toContain('VALET_BROWSER_ENABLED=1');
    expect(args).toContain('VALET_SESSION_ID=session');
    for (const denied of ['/etc/valet/creds', 'docker.sock', 'VALET_SANDBOX_DOCKER', 'VALET_BROWSER_VIEWER', 'SYS_ADMIN', 'NET_ADMIN', 'unconfined', '/start-headless.sh', '/start-full.sh']) expect(args.join(' ')).not.toContain(denied);
    expect(args).not.toContain('-p');
    expect(args.join(' ')).toContain('/browser-preflight.sh');
    expect(args.join(' ')).toContain('/usr/bin/tini');
  });
  it('validates each role, pinned image, exact network owner, and the exclusive private mount', () => {
    const saved = record();
    const workload = { id: 'workload-id', imageId: 'sha256:workload', labels: dockerOwnerLabels(saved), mounts: [{ source: '/work', destination: '/workspace' }], running: true };
    expect(() => validateDockerOwner(saved, workload)).not.toThrow();
    expect(() => validateDockerOwner(saved, { ...workload, mounts: [...workload.mounts, { source: saved.runtimeStateDir, destination: '/var/lib/valet' }] })).toThrow(/mount/i);
    const actual = { id: 'browser-id', imageId: 'sha256:browser', labels: { ...dockerOwnerLabels(saved), 'valet.dev/container-role': 'browser' }, mounts: [{ source: saved.runtimeStateDir, destination: '/var/lib/valet', readOnly: false }, { source: '/work', destination: '/workspace', readOnly: true }], networkMode: 'container:workload-id', running: true };
    expect(() => validateDockerBrowserOwner(saved, actual)).not.toThrow();
    for (const change of [{ id: 'other' }, { imageId: 'other' }, { networkMode: 'container:workload-owner' }, { labels: dockerOwnerLabels(saved) }, { mounts: [...actual.mounts, { source: '/work', destination: '/workspace', readOnly: true }] }, { mounts: actual.mounts.map(mount => ({ ...mount, readOnly: false })) }, { mounts: actual.mounts.map(mount => ({ ...mount, readOnly: true })) }]) expect(() => validateDockerBrowserOwner(saved, { ...actual, ...change })).toThrow();
  });
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'valet-companion-')));
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(root, 'calls'))},JSON.stringify(args)+'\\n');if(args[0]==='exec'){process.stdout.write(args.join(' '));}else if(args[0]!=='rm'){process.exit(125)}`, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('round-trips companion identities and rejects incomplete running ownership', async () => {
  const inventory = new DockerInventory(root); const saved = record(root);
  await inventory.write(saved); expect(await inventory.read(saved.id)).toEqual(saved);
  await inventory.write({ ...saved, browserCompanion: { ...companion, networkOwnerId: 'other' } });
  await expect(inventory.read(saved.id)).rejects.toThrow(/inventory/i);
});
it('routes trusted browser exec and channel to the companion while preserving Docker workload semantics', async () => {
  const sandbox = new DockerSandbox('dsb-test', { containerId: 'workload-id', browserContainerId: 'browser-id', docker: true, browser: true, workspace: '/work', containerWorkspace: '/workspace', image: 'repo:bake' });
  const workload = await sandbox.exec('docker info');
  expect(workload.stdout).toContain('workload-id sh -c docker info');
  expect(workload.stdout).toContain('-u dockerd');
  expect(workload.stdout).not.toContain('setpriv');
  const browser = await sandbox.exec('valet-browser-client', { privileged: true, target: 'browser' });
  expect(browser.stdout).toContain('--workdir / browser-id sh -c valet-browser-client');
  expect(browser.stdout).not.toContain('-u dockerd');
  const output: string[] = []; let closed!: () => void; const done = new Promise<void>(resolve => { closed = resolve; });
  await sandbox.openCommandChannel('valet-browser-client channel', { privileged: true, target: 'browser', onData: data => output.push(data), onClose: closed });
  await done;
  expect(output.join('')).toContain('browser-id sh -c valet-browser-client channel');
});
it('rejects browser targets without trust or a required companion and retains ordinary browser routing', async () => {
  const options = { containerId: 'workload-id', workspace: '/work', containerWorkspace: '/workspace', image: 'repo:bake' };
  await expect(new DockerSandbox('dsb-x', { ...options, browser: true, docker: true }).exec('id', { privileged: true, target: 'browser' })).rejects.toThrow(/companion/i);
  await expect(new DockerSandbox('dsb-x', options).exec('id', { privileged: true, target: 'browser' })).rejects.toThrow(/browser/i);
  await expect(new DockerSandbox('dsb-x', { ...options, browser: true }).exec('id', { target: 'browser' })).rejects.toThrow(/privileged|trusted/i);
  const normal = await new DockerSandbox('dsb-x', { ...options, browser: true }).exec('id', { privileged: true, target: 'browser' });
  expect(normal.stdout).toContain('workload-id sh -c id');
});
it('removes the companion before the workload when a sandbox is destroyed directly', async () => {
  const sandbox = new DockerSandbox('dsb-test', { containerId: 'workload-id', browserContainerId: 'browser-id', docker: true, browser: true, workspace: '/work', containerWorkspace: '/workspace', image: 'repo:bake' });
  await sandbox.destroy();
  const { readFile } = await import('node:fs/promises');
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls).toEqual([['rm', '-f', 'browser-id'], ['rm', '-f', 'workload-id']]);
});
