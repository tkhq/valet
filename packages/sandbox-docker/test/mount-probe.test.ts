import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DockerSandboxProvider, type DockerSandboxCreateOpts } from '../src/sandbox.js';

// The image entrypoint can give /workspace to the in-container workload user.
// The API's user then cannot create files in the host directory, and the old
// host-written probe failed every create for that workspace with EACCES.
let root: string;
let workspace: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'valet-mount-probe-')));
  workspace = join(root, 'workspace');
  await mkdir(workspace);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(root, 'containers'), '[]');
  // A fake docker. `exec --user 0` writes as root, so it ignores the mode bits.
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);const file=${JSON.stringify(join(root, 'containers'))};
let owners=JSON.parse(fs.readFileSync(file,'utf8'));const save=()=>fs.writeFileSync(file,JSON.stringify(owners));
const fail=m=>{process.stderr.write(m);process.exit(1);};
if(a[0]==='info'){process.stdout.write('fixture-daemon');}
else if(a[0]==='run'){const mounts=[];for(let i=0;i<a.length;i++)if(a[i]==='-v'){const [Source,Destination]=a[++i].split(':');mounts.push({Source,Destination});}
 const labels={};for(let i=0;i<a.length;i++)if(a[i]==='--label'){const [k,...v]=a[++i].split('=');labels[k]=v.join('=');}
 const id='workload-'+(owners.length+1);owners.push({Id:id,Name:a[a.indexOf('--name')+1],Image:'sha256:workload',Config:{Labels:labels},HostConfig:{NetworkMode:'bridge'},State:{Running:true},Mounts:mounts});save();process.stdout.write(id);}
else if(a[0]==='inspect'){const o=owners.find(o=>o.Id===a.at(-1)||o.Name===a.at(-1));if(!o)fail('No such container');process.stdout.write(a.includes('-f')?String(o.State.Running):JSON.stringify([o]));}
else if(a[0]==='ps'){process.stdout.write(owners.map(o=>o.Id).join('\\n'));}
else if(a[0]==='rm'){owners=owners.filter(o=>o.Id!==a.at(-1));save();}
else if(a[0]==='exec'){const o=owners.find(o=>a.includes(o.Id));if(!o)fail('No such container');
 const dir=o.Mounts.find(m=>m.Destination==='/workspace').Source;const asRoot=a.includes('--user')&&a[a.indexOf('--user')+1]==='0';
 const probe=/^printf %s (\\S+) > \\/workspace\\/\\.valet-mount-probe$/.exec(a.at(-1));
 const write=fn=>{if(!asRoot)fail('Permission denied');const mode=fs.statSync(dir).mode;fs.chmodSync(dir,0o755);try{fn();}finally{fs.chmodSync(dir,mode);}};
 if(probe)write(()=>fs.writeFileSync(path.join(dir,'.valet-mount-probe'),probe[1]));
 else if(a.at(-1)==='/workspace/.valet-mount-probe'&&a.includes('rm'))write(()=>fs.rmSync(path.join(dir,'.valet-mount-probe'),{force:true}));}
else fail('unexpected fake Docker operation '+a.join(' '));
`, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await chmod(workspace, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

it('creates a sandbox when the host cannot create files in the working directory', async () => {
  await chmod(workspace, 0o555);
  const provider = new DockerSandboxProvider({ inventoryRoot: join(root, 'private') });
  const opts: DockerSandboxCreateOpts = { sessionId: 'probe-session', workspace, image: 'repo:bake', pullIfMissing: false };
  const sandbox = await provider.create(opts);
  expect(sandbox.id).toBeTruthy();
  expect(await readdir(workspace)).toEqual([]);
});
