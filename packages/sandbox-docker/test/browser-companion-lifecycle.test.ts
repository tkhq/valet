import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DockerInventory } from '../src/inventory.js';
import { DockerSandboxProvider } from '../src/sandbox.js';

let root: string;
let config: { inventoryRoot: string; browserEnabled: boolean; browserImage: string };
let opts: { sessionId: string; workspace: string; image: string; docker: boolean; browser: { enabled: boolean }; pullIfMissing: boolean };
const calls = async (): Promise<string[][]> => (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
interface FixtureOwner { Id: string; Image: string; HostConfig: { NetworkMode: string }; State: { Running: boolean }; Mounts: { Source: string; Destination: string }[] }
const containers = async (): Promise<FixtureOwner[]> => JSON.parse(await readFile(join(root, 'containers'), 'utf8'));
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'valet-companion-lifecycle-')));
  config = { inventoryRoot: join(root, 'private'), browserEnabled: true, browserImage: 'stock:browser' };
  opts = { workspace: join(root, 'workspace'), sessionId: 'companion-session', image: 'repo:bake', docker: true, browser: { enabled: true }, pullIfMissing: false };
  await mkdir(opts.workspace); const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(root, 'containers'), '[]');
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const root=${JSON.stringify(root)};const a=process.argv.slice(2);fs.appendFileSync(path.join(root,'calls'),JSON.stringify(a)+'\\n');const file=path.join(root,'containers');let owners=JSON.parse(fs.readFileSync(file,'utf8'));const save=()=>fs.writeFileSync(file,JSON.stringify(owners));const fail=message=>{process.stderr.write(message);process.exit(125)};
if(a[0]==='info'){process.stdout.write('fixture-daemon');}
else if(a[0]==='run' && a.includes('--rm')){process.stdout.write('{"entries":[],"total":0}');}
else if(a[0]==='run'){
 const browser=a.includes('valet.dev/container-role=browser');if(browser && fs.existsSync(path.join(root,'fail-browser')))fail('injected browser creation failure');
 const labels={};const mounts=[];for(let i=0;i<a.length;i++){if(a[i]==='--label'){const [key,...v]=a[++i].split('=');labels[key]=v.join('=');}if(a[i]==='-v'){const [Source,Destination,mode]=a[++i].split(':');mounts.push({Source,Destination,RW:mode!=='ro'});}}
 const id=(browser?'browser-':'workload-')+(owners.length+1);const owner={Id:id,Name:a[a.indexOf('--name')+1],Image:browser?'sha256:browser':'sha256:workload',Config:{Labels:labels},HostConfig:{NetworkMode:a.includes('--network')?a[a.indexOf('--network')+1]:'bridge'},State:{Running:true},Mounts:mounts};owners.push(owner);save();process.stdout.write(id);
}
else if(a[0]==='inspect'){
 const owner=owners.find(o=>o.Id===a.at(-1)||o.Name===a.at(-1));if(!owner)fail('No such container');if(owner.Id.startsWith('browser-')&&fs.existsSync(path.join(root,'fail-browser-inspection')))fail('injected browser inspection failure');process.stdout.write(a.includes('-f')?String(owner.State.Running):JSON.stringify([owner]));
}
else if(a[0]==='ps'){process.stdout.write(owners.map(o=>o.Id).join('\\n'));}
else if(a[0]==='stop'){const owner=owners.find(o=>o.Id===a.at(-1));if(!owner)fail('No such container');owner.State.Running=false;save();}
else if(a[0]==='rm'){owners=owners.filter(o=>o.Id!==a.at(-1));save();}
else if(a[0]==='exec'){
 const owner=owners.find(o=>a.includes(o.Id));if(!owner)fail('No such container');
 if(a.at(-1).startsWith('cat /workspace/.valet-mount-probe')){const mount=owner.Mounts.find(m=>m.Destination==='/workspace');process.stdout.write(fs.readFileSync(path.join(mount.Source,'.valet-mount-probe'),'utf8'));}
}
else fail('unexpected fake Docker operation '+a.join(' '));
`, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('creates and adopts both exact owners, then removes the companion first while retaining state until final deletion', async () => {
  const first = new DockerSandboxProvider(config); const sandbox = await first.create(opts);
  const inventory = new DockerInventory(config.inventoryRoot); const saved = (await inventory.read(sandbox.id))!;
  expect(saved.browserCompanion).toMatchObject({ containerId: 'browser-2', networkOwnerId: 'workload-1', imageId: 'sha256:browser', image: 'stock:browser' });
  const run = (await calls()).filter(args => args[0] === 'run');
  expect(run).toHaveLength(2);
  expect(run[0].join(' ')).not.toContain('/var/lib/valet');
  expect(run[0].join(' ')).not.toContain('VALET_BROWSER_ENABLED');
  expect(run[1]).toContain('container:workload-1');
  const restarted = new DockerSandboxProvider(config); const adopted = await restarted.restore(sandbox.id);
  expect(adopted.browserContainerId).toBe('browser-2');
  await writeFile(join(saved.runtimeStateDir, 'retained'), 'private');
  await restarted.release(sandbox.id);
  expect((await calls()).filter(args => args[0] === 'rm').map(args => args.at(-1))).toEqual(['browser-2', 'workload-1']);
  expect(await readFile(join(saved.runtimeStateDir, 'retained'), 'utf8')).toBe('private');
  const replacement = await restarted.create(opts);
  expect(replacement.id).toBe(sandbox.id);
  await restarted.destroy(replacement.id);
  expect(await inventory.read(sandbox.id)).toBeUndefined();
  await expect(readFile(join(saved.runtimeStateDir, 'retained'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['network', 'image', 'mount', 'missing', 'duplicate'])('rejects %s companion adoption without creating another owner', async failure => {
  const sandbox = await new DockerSandboxProvider(config).create(opts);
  const owners = await containers();
  if(failure === 'network') owners[1].HostConfig.NetworkMode = 'container:someone-else';
  if(failure === 'image') owners[1].Image = 'sha256:other';
  if(failure === 'mount') owners[1].Mounts.push({Source:'/work',Destination:'/workspace'});
  if(failure === 'missing') owners.pop();
  if(failure === 'duplicate') owners.push({...owners[1],Id:'extra'});
  await writeFile(join(root, 'containers'), JSON.stringify(owners));
  await expect(new DockerSandboxProvider(config).restore(sandbox.id)).rejects.toThrow(/network|image|mount|missing|Multiple/i);
  expect((await calls()).filter(args => args[0] === 'run')).toHaveLength(2);
});

it('retains pending ownership after companion creation fails and requires explicit release before retry', async () => {
  await writeFile(join(root, 'fail-browser'), '1'); const first = new DockerSandboxProvider(config);
  await expect(first.create(opts)).rejects.toThrow(/creation failed/i);
  const saved = (await new DockerInventory(config.inventoryRoot).list())[0];
  expect(saved).toMatchObject({ state: 'creating', containerId: 'workload-1', imageId: 'sha256:workload', browserCompanion: { networkOwnerId: 'workload-1' } });
  expect(await containers()).toHaveLength(1);
  await rm(join(root, 'fail-browser'));
  await expect(new DockerSandboxProvider(config).create(opts)).rejects.toThrow(/missing|pending|creating/i);
  expect((await calls()).filter(args => args[0] === 'run')).toHaveLength(2);
  await first.release(saved.id); await first.create(opts);
  expect(await containers()).toHaveLength(2);
});

it('reads a released audit through the pinned companion image', async () => {
  const provider = new DockerSandboxProvider(config); const sandbox = await provider.create(opts);
  const saved = (await new DockerInventory(config.inventoryRoot).read(sandbox.id))!;
  await mkdir(join(saved.runtimeStateDir, 'browser')); await writeFile(join(saved.runtimeStateDir, 'browser/journal.sqlite'), 'fixture');
  await provider.release(sandbox.id); expect(await provider.readBrowserAudit(sandbox.id)).toEqual({ entries: [], total: 0 });
  const reader = (await calls()).find(args => args.includes('/usr/bin/flock'))!;
  expect(reader).toContain('sha256:browser'); expect(reader).not.toContain('repo:bake');
});

it.each([false, true])('upgrades a legacy Docker-only runtime (released=%s) with fresh browser state and preserves the old state until final deletion', async released => {
  const provider = new DockerSandboxProvider(config);
  const initial = await provider.create({ ...opts, browser: undefined });
  const inventory = new DockerInventory(config.inventoryRoot); const legacy = (await inventory.read(initial.id))!;
  await mkdir(join(legacy.runtimeStateDir, 'browser'));
  await writeFile(join(legacy.runtimeStateDir, 'browser/journal.sqlite'), 'workload-planted-state');
  await writeFile(join(opts.workspace, 'kept.txt'), 'working directory');
  if (released) await provider.release(initial.id);
  const upgraded = await provider.create(opts); const saved = (await inventory.read(upgraded.id))!;
  expect(saved.runtimeStateDir).not.toBe(legacy.runtimeStateDir);
  expect(saved.workloadStateDir).toBe(legacy.runtimeStateDir);
  expect(saved.browserCompanion?.containerId).toBeDefined();
  await expect(readFile(join(saved.runtimeStateDir, 'browser/journal.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(legacy.runtimeStateDir, 'browser/journal.sqlite'), 'utf8')).toBe('workload-planted-state');
  expect(await readFile(join(opts.workspace, 'kept.txt'), 'utf8')).toBe('working directory');
  const restarted = new DockerSandboxProvider(config); await restarted.restore(upgraded.id); await restarted.release(upgraded.id);
  await restarted.create(opts); const replacement = (await inventory.read(upgraded.id))!;
  expect(replacement.runtimeStateDir).toBe(saved.runtimeStateDir);
  expect(replacement.workloadStateDir).toBe(legacy.runtimeStateDir);
  await restarted.destroy(upgraded.id);
  await expect(readFile(join(legacy.runtimeStateDir, 'browser/journal.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['missing', 'stopped'])('stops the verified browser owner to export retained audit after workload loss (%s)', async failure => {
  const provider = new DockerSandboxProvider(config); const sandbox = await provider.create(opts);
  const saved = (await new DockerInventory(config.inventoryRoot).read(sandbox.id))!;
  await mkdir(join(saved.runtimeStateDir, 'browser')); await writeFile(join(saved.runtimeStateDir, 'browser/journal.sqlite'), 'fixture');
  const owners = await containers(); if (failure === 'missing') owners.shift(); else owners[0].State.Running = false;
  await writeFile(join(root, 'containers'), JSON.stringify(owners));
  expect(await provider.status(sandbox.id)).toEqual({ id: sandbox.id, state: 'released' });
  expect(await provider.readBrowserAudit(sandbox.id)).toEqual({ entries: [], total: 0 });
  expect((await calls()).filter(args => args[0] === 'stop')).toEqual([['stop', '--time', '30', 'browser-2']]);
  await provider.destroy(sandbox.id); expect(await containers()).toHaveLength(0);
});

it('keeps upgraded private state when a released session disables Docker but retains its browser', async () => {
  const provider = new DockerSandboxProvider(config); const original = await provider.create({ ...opts, browser: undefined });
  await provider.create(opts); const inventory = new DockerInventory(config.inventoryRoot); const upgraded = (await inventory.read(original.id))!;
  await provider.release(original.id);
  const ordinary = await provider.create({ ...opts, docker: false, image: config.browserImage });
  const restarted = new DockerSandboxProvider(config); await restarted.restore(ordinary.id);
  const retained = (await inventory.read(ordinary.id))!;
  expect(retained.runtimeStateDir).toBe(upgraded.runtimeStateDir);
  expect(retained.workloadStateDir).toBe(upgraded.workloadStateDir);
  expect(retained.browserCompanion).toBeUndefined();
  await restarted.destroy(ordinary.id);
});

it.each([false, true])('exports audit and deletes an interrupted creation with two live owners (journal=%s)', async journal => {
  await writeFile(join(root, 'fail-browser-inspection'), '1');
  const provider = new DockerSandboxProvider(config);
  await expect(provider.create(opts)).rejects.toThrow(/inspect/i);
  const inventory = new DockerInventory(config.inventoryRoot);
  const saved = (await inventory.list())[0];
  expect(saved.state).toBe('creating');
  expect(saved.browserCompanion?.containerId).toBe('browser-2');
  expect(saved.browserCompanion?.imageId).toBeUndefined();
  expect((await containers()).every(owner => owner.State.Running)).toBe(true);
  await rm(join(root, 'fail-browser-inspection'));
  if (journal) {
    await mkdir(join(saved.runtimeStateDir, 'browser'));
    await writeFile(join(saved.runtimeStateDir, 'browser/journal.sqlite'), 'fixture');
  }
  expect(await provider.status(saved.id)).toEqual({ id: saved.id, state: 'released' });
  expect(await provider.readBrowserAudit(saved.id)).toEqual({ entries: [], total: 0 });
  expect((await calls()).filter(args => args[0] === 'stop')).toEqual([['stop', '--time', '30', 'browser-2']]);
  if (journal) expect((await calls()).find(args => args.includes('/usr/bin/flock'))).toContain('sha256:browser');
  await provider.destroy(saved.id);
  expect(await containers()).toHaveLength(0);
  expect(await inventory.read(saved.id)).toBeUndefined();
});

it('cleans interrupted creation by verified names when the container IDs were not persisted', async () => {
  const provider = new DockerSandboxProvider(config); const sandbox = await provider.create(opts);
  const inventory = new DockerInventory(config.inventoryRoot); const saved = (await inventory.read(sandbox.id))!;
  saved.state = 'creating'; delete saved.containerId; delete saved.imageId;
  delete saved.browserCompanion!.containerId; delete saved.browserCompanion!.imageId; delete saved.browserCompanion!.networkOwnerId;
  await inventory.write(saved);
  expect(await provider.readBrowserAudit(saved.id)).toEqual({ entries: [], total: 0 });
  await provider.destroy(saved.id);
  expect((await calls()).filter(args => args[0] === 'rm').map(args => args.at(-1))).toEqual(['browser-2', 'workload-1']);
  expect(await inventory.read(saved.id)).toBeUndefined();
});
