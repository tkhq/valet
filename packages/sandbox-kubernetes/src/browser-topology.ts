import { createHash } from 'node:crypto';
import type { SandboxCRRead } from './types.js';
import {
  BROWSER_CONTAINER_NAME, BROWSER_LABEL_KEY, BROWSER_TOPOLOGY_ANNOTATION,
  DOCKER_LABEL_KEY, IMAGE_FINGERPRINT_ENV, NESTED_KUBERNETES_LABEL_KEY, SANDBOX_CONTAINER_NAME, imageFingerprint,
} from './manifest.js';
import { WORKSPACE_SUBPATH } from './home-persistence.js';
import { RUNTIME_STATE_ANNOTATION } from './runtime-state.js';
import { workspacePvcName } from './workspace-pvc.js';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function containers(template: unknown): Record<string, unknown>[] {
  return records(record(record(template).spec).containers);
}
export function hasBrowserCompanion(template: unknown): boolean {
  return containers(template).some(container => container.name === BROWSER_CONTAINER_NAME);
}

/** Read the browser generation from live configuration, including its private mount boundary. */
export function browserRuntimeFingerprint(template: unknown, sandboxName?: string): string | undefined {
  const spec = record(record(template).spec);
  const workload = containers(template).find(container => container.name === SANDBOX_CONTAINER_NAME);
  const companion = containers(template).find(container => container.name === BROWSER_CONTAINER_NAME);
  const browser = companion ?? (records(workload?.env).some(entry => entry.name === 'VALET_BROWSER_ENABLED' && entry.value === '1') ? workload : undefined);
  if (!browser) return undefined;
  const env = records(browser.env);
  const requestedImage = env.find(entry => entry.name === IMAGE_FINGERPRINT_ENV && entry.valueFrom === undefined)?.value;
  const security = record(browser.securityContext);
  const mounts = records(browser.volumeMounts);
  // The controller materializes volumeClaimTemplates as workspace-<sandboxName>.
  // Only CR callers supply the expected name. A live pod must carry the actual PVC source.
  const workspaceVolume = records(spec.volumes).find(volume => volume.name === 'workspace') ??
    (sandboxName ? { persistentVolumeClaim: { claimName: workspacePvcName(sandboxName) } } : {});
  const workspaceClaim = record(workspaceVolume.persistentVolumeClaim);
  return createHash('sha256').update(JSON.stringify({
    name: browser.name,
    image: requestedImage ?? imageFingerprint(typeof browser.image === 'string' ? browser.image : ''),
    command: browser.command, args: browser.args ?? [],
    resources: companion ? ["requests", "limits"].map(side => Object.entries(record(record(browser.resources)[side])).map(([key, value]) => [key, String(value)]).sort()) : undefined,
    env: env.filter(entry => companion ? entry.name !== IMAGE_FINGERPRINT_ENV : String(entry.name).startsWith('VALET_BROWSER_')).map(entry => [entry.name, entry.value, entry.valueFrom]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    security: { seccompProfile: security.seccompProfile, privileged: security.privileged ?? false, capabilities: record(security.capabilities).add ?? [], procMount: security.procMount ?? 'Default' },
    mounts: (companion ? mounts : mounts.filter(mount => mount.name === 'runtime-state')).map(mount => [mount.name, mount.mountPath, mount.subPath ?? '', mount.readOnly ?? false]).sort(),
    privateClaim: record(records(spec.volumes).find(volume => volume.name === 'runtime-state')?.persistentVolumeClaim).claimName,
    workspaceSource: companion ? {
      claimName: workspaceClaim.claimName,
      readOnly: workspaceClaim.readOnly ?? false,
      sources: Object.keys(workspaceVolume).filter(key => key !== 'name').sort(),
    } : undefined,
    workloadPrivateMounts: companion ? records(workload?.volumeMounts).filter(mount => mount.name === 'runtime-state') : undefined,
    readiness: record(record(browser.readinessProbe).exec).command,
    serviceAccount: companion ? spec.automountServiceAccountToken : undefined,
  })).digest('hex');
}

/** Validate persisted topology before selecting a trusted browser execution target. */
export function browserTargetContainer(cr: SandboxCRRead): string {
  if (!cr.metadata.annotations?.[RUNTIME_STATE_ANNOTATION] && cr.metadata.labels?.[BROWSER_LABEL_KEY] !== 'true') {
    throw new Error('Browser execution is disabled. Enable the managed browser before sending browser commands.');
  }
  const podContainers = containers(cr.spec.podTemplate);
  const workload = podContainers.find(container => container.name === SANDBOX_CONTAINER_NAME);
  const companion = cr.metadata.annotations?.[BROWSER_TOPOLOGY_ANNOTATION] === 'companion' ||
    cr.metadata.labels?.[DOCKER_LABEL_KEY] === 'true' || cr.metadata.labels?.[NESTED_KUBERNETES_LABEL_KEY] === 'true' ||
    record(record(workload?.securityContext).seccompProfile).type === 'Unconfined' || hasBrowserCompanion(cr.spec.podTemplate);
  const containerName = companion ? BROWSER_CONTAINER_NAME : SANDBOX_CONTAINER_NAME;
  const target = podContainers.find(container => container.name === containerName);
  const security = record(target?.securityContext);
  const mounts = records(target?.volumeMounts);
  const elevated = record(security.capabilities).add;
  const exactCompanionMounts = mounts.length === 2 &&
    mounts.some(mount => mount.name === 'runtime-state' && mount.mountPath === '/var/lib/valet' &&
      mount.subPath === undefined && mount.subPathExpr === undefined && (mount.readOnly === undefined || mount.readOnly === false)) &&
    mounts.some(mount => mount.name === 'workspace' && mount.mountPath === '/workspace' &&
      mount.subPath === WORKSPACE_SUBPATH && mount.subPathExpr === undefined && mount.readOnly === true);
  if (!target || record(security.seccompProfile).type !== 'Localhost' || security.privileged ||
    (Array.isArray(elevated) && elevated.length > 0) ||
    !mounts.some(mount => mount.name === 'runtime-state' && mount.mountPath === '/var/lib/valet') ||
    (companion && (!exactCompanionMounts || records(workload?.volumeMounts).some(mount => mount.name === 'runtime-state')))) {
    throw new Error('Browser container isolation is missing or invalid. Recreate this sandbox with the managed browser enabled.');
  }
  return containerName;
}
