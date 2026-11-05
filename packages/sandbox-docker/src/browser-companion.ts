import { dockerBrowserOwnerLabels, type DockerInventoryRecord } from './inventory.js';

/** A browser owner shares the workload network and reads approved uploads from a read-only working directory. */
export function buildBrowserCompanionArgs(options: {
  owner: DockerInventoryRecord;
  seccompProfile: string;
  uid: number;
  gid: number;
  devPorts?: string;
}): string[] {
  const { owner, seccompProfile, uid, gid } = options;
  const companion = owner.browserCompanion;
  if (!companion?.networkOwnerId || companion.networkOwnerId !== owner.containerId)
    throw new Error('The browser network owner is missing. Record the workload container before starting its companion.');
  if (!seccompProfile)
    throw new Error('Browser seccomp profile is missing. Configure the reviewed browser profile before starting this sandbox.');
  const args = [
    'run', '-d', '--name', companion.containerName,
    '--network', `container:${companion.networkOwnerId}`,
    '--security-opt', `seccomp=${seccompProfile}`,
    '--cpus', '2', '--memory', '2147483648', '--shm-size', '268435456',
    '-v', `${owner.runtimeStateDir}:/var/lib/valet`,
    '-v', `${owner.workspace}:/workspace:ro`,
  ];
  for (const [key, value] of Object.entries(dockerBrowserOwnerLabels(owner))) args.push('--label', `${key}=${value}`);
  for (const [key, value] of Object.entries({
    VALET_SESSION_ID: owner.sessionId,
    VALET_BROWSER_ENABLED: '1', VALET_BROWSER_CONFINE: '1',
    VALET_BROWSER_STATE: '/var/lib/valet/browser',
    VALET_BROWSER_WORKSPACE_READONLY: '1',
    VALET_BROWSER_UID: String(uid), VALET_BROWSER_GID: String(gid),
    VALET_BROWSER_DEV_PORTS: options.devPorts ?? '5173,3000,8080',
  })) args.push('--env', `${key}=${value}`);
  args.push('--entrypoint', '/usr/bin/tini', companion.image, '-g', '--', '/bin/bash', '-c', '/bin/bash /browser-preflight.sh && exec tail -f /dev/null');
  return args;
}
