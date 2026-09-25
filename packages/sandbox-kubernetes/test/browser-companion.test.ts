import { EventEmitter } from 'node:events';
import type { V1Container, V1Pod } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { buildSandboxManifest, BROWSER_LABEL_KEY } from '../src/manifest.js';
import { KubernetesSandboxProvider } from '../src/provider.js';
import { browserRuntimeFingerprint, browserTargetContainer, hasBrowserCompanion } from '../src/browser-topology.js';
import { livePodDrift, podStatusApiAdapter, podTemplateResourceFingerprint, sandboxStatus } from '../src/lifecycle.js';
import type { SandboxCustomObjectsApi } from '../src/lifecycle.js';
import type { PodExecApi } from '../src/exec.js';
import { SANDBOX_CR_API_VERSION, type SandboxCRRead } from '../src/types.js';
import type { RuntimeStateClaim } from '../src/runtime-state.js';

const cfg = { namespace: 'test', defaultImage: 'stock:1', apiVersion: SANDBOX_CR_API_VERSION };
function fixture(combined = true) {
  const cr = buildSandboxManifest(cfg, 'sandbox-id', { sessionId: 'session', docker: combined, browser: { enabled: true } });
  cr.metadata.annotations = { ...cr.metadata.annotations, 'agents.x-k8s.io/pod-name': 'pod' };
  const objectsApi: SandboxCustomObjectsApi = {
    getNamespacedCustomObject: async () => ({ ...cr, status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
    listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject: vi.fn(), replaceNamespacedCustomObject: vi.fn(),
    patchNamespacedCustomObject: vi.fn(), deleteNamespacedCustomObject: vi.fn(),
  };
  const socket = Object.assign(new EventEmitter(), { close: vi.fn(), readyState: 1, bufferedAmount: 0 });
  const exec: PodExecApi['exec'] = vi.fn(async (_namespace, _pod, _container, _command, _stdout, _stderr, _stdin, _tty, callback) => {
    if (!_command.join(' ').includes('browser-client')) queueMicrotask(() => callback?.({ status: 'Success' })); return socket;
  });
  const liveSpec = () => ({ ...structuredClone(cr.spec.podTemplate.spec), volumes: [...structuredClone(cr.spec.podTemplate.spec.volumes ?? []), { name: "workspace", persistentVolumeClaim: { claimName: `workspace-${cr.metadata.name}` } }], containers: cr.spec.podTemplate.spec.containers.map(({ resources, ...container }): V1Container => ({ ...structuredClone(container), ...(resources ? { resources: { requests: Object.fromEntries(Object.entries(resources.requests ?? {}).map(([key, value]) => [key, String(value)])), limits: Object.fromEntries(Object.entries(resources.limits ?? {}).map(([key, value]) => [key, String(value)])) } } : {}) })), initContainers: undefined });
  const pod: V1Pod & { spec: ReturnType<typeof liveSpec>; status: { phase: string; conditions: { type: string; status: string }[]; containerStatuses: { name: string; image: string; ready: boolean; restartCount: number }[] } } = { spec: liveSpec(), status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'sandbox', image: 'stock:1', imageID: 'stock:1', ready: true, restartCount: 0 }, ...(combined ? [{ name: 'browser', image: 'stock:1', imageID: 'stock:1', ready: true, restartCount: 0 }] : [])] } };
  const podStatusApi = podStatusApiAdapter({ readNamespacedPod: async () => pod });
  const deps = { objectsApi, podsApi: { listNamespacedPod: async () => ({ items: [] }) }, execApi: { exec }, livenessApi: { getPodUid: async () => 'uid' }, podStatusApi };
  return { cr, pod, liveSpec, exec, deps, provider: new KubernetesSandboxProvider(deps, cfg) };
}

describe('browser companion routing', () => {
  it.each(['extra-state-alias', 'missing-workspace', 'state-subpath', 'readonly-state', 'duplicate-workspace'])('rejects the invalid companion mount layout %s', (mode) => {
    const f = fixture();
    const browser = f.cr.spec.podTemplate.spec.containers[1];
    const mounts = browser.volumeMounts ?? [];
    const state = mounts.find(mount => mount.name === 'runtime-state');
    if (mode === 'extra-state-alias') mounts.push({ name: 'runtime-state', mountPath: '/workspace/private' });
    if (mode === 'missing-workspace') browser.volumeMounts = mounts.filter(mount => mount.name !== 'workspace');
    if (mode === 'state-subpath' && state) state.subPath = 'browser';
    if (mode === 'readonly-state' && state) state.readOnly = true;
    if (mode === 'duplicate-workspace') mounts.push({ name: 'workspace', mountPath: '/workspace', subPath: '.valet-storage/workspace', readOnly: true });
    expect(() => browserTargetContainer(f.cr)).toThrow(/isolation/i);
  });
  it('rejects browser jobs instead of running them in the workload', async () => {
    const f = fixture(); const sandbox = await f.provider.restore('sandbox-id');
    await expect(sandbox.execJob?.('browser-job', { target: 'browser', privileged: true })).rejects.toThrow(/browser.*job/i);
    expect(f.exec).not.toHaveBeenCalled();
  });
  it('routes trusted exec and channels to browser and leaves Docker workload commands free of browser no-new-privs', async () => {
    const f = fixture(); const sandbox = await f.provider.restore('sandbox-id');
    await sandbox.exec('browser-command', { target: 'browser', privileged: true });
    expect(vi.mocked(f.exec).mock.calls[0]?.[2]).toBe('browser');
    await sandbox.exec('docker info');
    expect(vi.mocked(f.exec).mock.calls[1]?.[2]).toBe('sandbox');
    expect(vi.mocked(f.exec).mock.calls[1]?.[3].join(' ')).not.toContain('--no-new-privs');
    const channel = await sandbox.openCommandChannel?.('browser-client', { target: 'browser', privileged: true, onData: vi.fn(), onClose: vi.fn() });
    expect(vi.mocked(f.exec).mock.calls[2]?.[2]).toBe('browser'); channel?.close();
  });
  it('retains the legacy colocated browser target', async () => {
    const f = fixture(false); const sandbox = await f.provider.restore('sandbox-id');
    await sandbox.exec('browser-command', { target: 'browser', privileged: true });
    expect(vi.mocked(f.exec).mock.calls[0]?.[2]).toBe('sandbox');
  });
  it.each(['disabled', 'missing-template', 'missing-live', 'unsafe-mount', 'writable-workspace', 'untrusted'])("rejects %s browser targets without workload fallback", async (mode) => {
    const f = fixture();
    if (mode === 'disabled') { f.cr.metadata.labels = { [BROWSER_LABEL_KEY]: 'false' }; f.cr.metadata.annotations = { 'agents.x-k8s.io/pod-name': 'pod' }; }
    if (mode === 'missing-template') f.cr.spec.podTemplate.spec.containers = f.cr.spec.podTemplate.spec.containers.filter(container => container.name !== 'browser');
    if (mode === 'missing-live') f.pod.spec.containers = f.pod.spec.containers.filter(container => container.name !== 'browser');
    if (mode === 'unsafe-mount') f.cr.spec.podTemplate.spec.containers[0].volumeMounts?.push({ name: 'runtime-state', mountPath: '/private' });
    if (mode === 'writable-workspace') { const mount = f.cr.spec.podTemplate.spec.containers[1].volumeMounts?.find(mount => mount.name === 'workspace'); if (mount) mount.readOnly = false; }
    const sandbox = await f.provider.restore('sandbox-id');
    await expect(sandbox.exec('browser-command', { target: 'browser', privileged: mode !== 'untrusted' })).rejects.toThrow(/browser|trusted/i);
    expect(f.exec).not.toHaveBeenCalled();
  });
});

describe('browser companion generation', () => {
  it('rejects a live browser working-directory mount backed by another claim or volume source', async () => {
    const f = fixture();
    const expected = browserRuntimeFingerprint(f.cr.spec.podTemplate, f.cr.metadata.name);
    const workspace = f.pod.spec.volumes.find(volume => volume.name === 'workspace');
    if (!workspace) throw new Error('The test working-directory volume is missing.');
    workspace.persistentVolumeClaim = { claimName: 'another-session' };
    const check = () => livePodDrift(f.deps.objectsApi, f.deps.podsApi, f.deps.podStatusApi, cfg, 'sandbox-id', 'stock:1', undefined, undefined, undefined, expected);
    expect(await check()).toMatchObject({ differs: true, browserDrift: true });
    expect((await sandboxStatus(f.deps.objectsApi, cfg, 'sandbox-id', f.deps.podsApi, f.deps.podStatusApi)).state).toBe('provisioning');
    delete workspace.persistentVolumeClaim;
    workspace.emptyDir = {};
    expect(await check()).toMatchObject({ differs: true, browserDrift: true });
  });
  it('upgrades an existing Docker-only session before returning an adopted handle', async () => {
    const f = fixture();
    let stored: SandboxCRRead = buildSandboxManifest(cfg, 'sandbox-id', { sessionId: 'session', docker: true });
    stored.metadata.annotations = { ...stored.metadata.annotations, 'agents.x-k8s.io/pod-name': 'pod' };
    let uid = 'old';
    f.pod.spec.containers.pop();
    const claims = new Map<string, RuntimeStateClaim>();
    const deletePod = vi.fn(async () => { f.pod.spec = f.liveSpec(); uid = 'new'; });
    f.deps.objectsApi.getNamespacedCustomObject = async () => ({ ...stored, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
    f.deps.objectsApi.createNamespacedCustomObject = async () => { throw { code: 409 }; };
    f.deps.objectsApi.replaceNamespacedCustomObject = async ({ body }) => {
      stored = body;
      stored.metadata.annotations = { ...stored.metadata.annotations, 'agents.x-k8s.io/pod-name': 'pod' };
      return stored;
    };
    const provider = new KubernetesSandboxProvider({ ...f.deps,
      livenessApi: { getPodUid: async () => uid }, podDeleteApi: { deletePod },
      podStatusApi: { getPodStatus: async (namespace, name) => ({ ...await f.deps.podStatusApi.getPodStatus(namespace, name), resourceFingerprint: podTemplateResourceFingerprint(stored.spec.podTemplate) }) },
      runtimeStateApi: {
        read: async (_namespace, name) => claims.get(name),
        create: async (_namespace, claim) => { claims.set(claim.metadata.name, claim); },
        list: async () => [...claims.values()], delete: async (_namespace, name) => { claims.delete(name); },
      },
    }, cfg);
    const sandbox = await provider.create({ workspace: 'sandbox-id', sessionId: 'session', docker: true, browser: { enabled: true } });
    expect(sandbox.adopted).toBe(true);
    expect(deletePod).toHaveBeenCalledOnce();
    expect(claims.size).toBe(1);
    await sandbox.exec('browser-command', { target: 'browser', privileged: true });
    expect(vi.mocked(f.exec).mock.calls[0]?.[2]).toBe('browser');
  });

  it('rolls a stale companion topology while resuming a Ready CR', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.pod.spec.containers.pop();
      const deletePod = vi.fn(async () => { f.pod.spec = f.liveSpec(); });
      const provider = new KubernetesSandboxProvider({ ...f.deps, podDeleteApi: { deletePod } }, cfg);
      const resuming = provider.resume('sandbox-id').then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await resuming).toBeUndefined();
      expect(deletePod).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('keeps browser status provisioning when the execution pod cannot be resolved', async () => {
    const f = fixture(); delete f.cr.metadata.annotations?.['agents.x-k8s.io/pod-name'];
    expect((await sandboxStatus(f.deps.objectsApi, cfg, 'sandbox-id', f.deps.podsApi, f.deps.podStatusApi)).state).toBe('provisioning');
  });

  it('detects companion image, confinement, and topology drift while preserving workload image checks', async () => {
    const f = fixture(); const expected = browserRuntimeFingerprint(f.cr.spec.podTemplate, f.cr.metadata.name);
    const check = () => livePodDrift(f.deps.objectsApi, f.deps.podsApi, f.deps.podStatusApi, cfg, 'sandbox-id', 'stock:1', undefined, undefined, undefined, expected);
    expect(await check()).toEqual({ differs: false });
    f.pod.spec.containers[1].env = f.pod.spec.containers[1].env?.filter(entry => entry.name !== 'VALET_SANDBOX_IMAGE_FINGERPRINT');
    f.pod.spec.containers[1].image = 'stock:old';
    expect(await check()).toMatchObject({ differs: true, browserDrift: true });
    f.pod.spec = f.liveSpec();
    f.pod.spec.containers[1].resources = { limits: { memory: '16Gi' } };
    expect(await check()).toMatchObject({ differs: true, browserDrift: true });
    f.pod.spec = f.liveSpec();
    f.pod.spec.containers[1].securityContext = { seccompProfile: { type: 'Unconfined' } };
    expect(await check()).toMatchObject({ differs: true, browserDrift: true });
    f.pod.spec.containers.pop();
    expect(await check()).toMatchObject({ differs: true, browserDrift: true });
  });
  it('does not report a stale Ready CR as ready when its companion is missing or unready', async () => {
    const f = fixture();
    f.pod.status.containerStatuses[1].ready = false;
    expect((await sandboxStatus(f.deps.objectsApi, cfg, 'sandbox-id', f.deps.podsApi, f.deps.podStatusApi)).state).toBe('provisioning');
    f.pod.spec.containers.pop();
    expect((await sandboxStatus(f.deps.objectsApi, cfg, 'sandbox-id', f.deps.podsApi, f.deps.podStatusApi)).state).toBe('provisioning');
  });
  it('does not fall back to a colocated browser for a combined CR with a removed topology marker', () => {
    const f = fixture(); delete f.cr.metadata.annotations?.['valet.dev/browser-topology'];
    f.cr.spec.podTemplate.spec.containers.pop();
    expect(() => browserTargetContainer(f.cr)).toThrow(/browser/i);
  });
});
