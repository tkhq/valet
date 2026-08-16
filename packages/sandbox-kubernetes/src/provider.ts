/**
 * `SandboxProvider`/`Sandbox` assembly (Task 5) — wires Tasks 1/2/4 (manifest
 * construction, CRD lifecycle, exec/files/job-mode) into the engine's
 * contract (`@valet/engine`'s `Sandbox`/`SandboxProvider`, see
 * `packages/engine/src/types.ts`).
 *
 * ── Teardown semantics (spec decision 5, NON-NEGOTIABLE) ────────────────
 * `create(opts)` is upsert-shaped: it calls `applySandbox`, which adopts an
 * existing CR of the same name rather than erroring (the attachment layer's
 * failure-recovery path calls `provider.create()` again with the same
 * opts). `restore(id)` GETs the CR and never creates. `destroy(id)` is
 * TERMINAL (deletes the CR, cascading to pod+PVC) and is the only method
 * that may delete a CR. `release(id)` is the NON-terminal seam: a no-op
 * that leaves the CR standing, consumed by the engine's
 * `SandboxAttachment.reportFailure` (liveness-triggered re-provision) in
 * preference to `destroy` when a provider implements it (see
 * `packages/engine/src/types.ts`'s `SandboxProvider.release`). Two
 * DIFFERENT engine call sites reach two DIFFERENT `Sandbox`/`SandboxProvider`
 * methods, and it is critical not to conflate them:
 *   - `SandboxAttachment.reportFailure` (non-terminal, epoch degradation)
 *     calls `provider.release(oldId)` directly when implemented, else
 *     `provider.destroy(oldId)` — it does NOT go through `Sandbox.destroy`
 *     at all.
 *   - `SandboxAttachment.destroy` (terminal, session deletion) calls
 *     `sandbox.destroy()` when the raw `Sandbox` defines one, else falls
 *     back to `provider.destroy(id)`. `KubernetesSandbox` deliberately does
 *     NOT define a `destroy()` method (see the class below) so this always
 *     falls through to `provider.destroy(id)` — the terminal CR+PVC delete.
 * The conformance suite's `recreate` callback (below, in
 * test/conformance.cluster.test.ts) is pod-recreate under the SAME
 * retained CR — never destroy+create — proving workspace survival the way
 * decision 5 mandates.
 *
 * ── Session identity → CR name ───────────────────────────────────────────
 * `SandboxCreateOpts` has no dedicated `sessionId` field (checked: neither
 * the engine's attachment layer nor `packages/api/src/engine/host.ts`'s
 * `provider.create()` call sites carry one — see host.ts's
 * `sandbox: { workspace, image, env }` construction). `opts.workspace` is
 * the one field every call site already populates with a
 * session-unique value (a per-session directory path, e.g.
 * `~/.valet/orchestrator/{principal}` or a per-session workspace dir) —
 * exactly mirroring how `DockerSandboxProvider.create` requires
 * `opts.workspace` as its own identity/addressing input (there: a host
 * bind-mount path; here: the string fed to `sandboxCrName` for a
 * deterministic CR name). Required, just like docker's.
 *
 * ── Liveness / SandboxUnavailableError translation ───────────────────────
 * This module never imports or constructs `SandboxUnavailableError` itself
 * — neither does `sandbox-docker`. Both providers throw a plain `Error`
 * whose message matches the engine's `CONTAINER_DEATH_PATTERN`
 * (`/No such container|is not running|Connection refused|socket hang up/i`,
 * `packages/engine/src/sandbox/policy.ts`); `PolicySandbox.dispatch` is the
 * ONE place that classifies that pattern match and wraps it as
 * `SandboxUnavailableError` before rethrowing. See `looksSignalKilled`/
 * `translateDeath` below for the k8s-specific detection this mirrors from
 * `packages/sandbox-docker/src/sandbox.ts`'s `looksSignalKilled`/
 * `isContainerAlive` pair — empirically verified against the live cluster
 * (see that pair's docblock) that `kubectl delete pod` mid-`exec` does NOT
 * fail the `pods/exec` WebSocket transport; the apiserver instead reports
 * the container's SIGKILL as an ordinary exit-137 status on the SAME
 * status channel a real in-container `kill -9` would use — ambiguous
 * exactly like docker's own exec-mid-`docker rm -f` case, so the same
 * "signal-shaped exit code → confirm via a liveness probe" disambiguation
 * applies.
 */
import type * as k8s from "@kubernetes/client-node";
import { setHeaderOptions } from "@kubernetes/client-node";
import { CONTAINER_DEATH_PATTERN, SandboxStartupError } from "@valet/engine";
import type {
  ExecJobHandle,
  ExecOpts,
  ExecResult,
  GatewayEndpoint,
  JobPoll,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";
import { execInPod, type ExecDeps, type PodExecApi } from "./exec.js";
import {
  mkdirInPod,
  PodFileOpError,
  readBinaryInPod,
  readFileInPod,
  readdirInPod,
  rmInPod,
  statInPod,
  writeBinaryInPod,
  writeFileInPod,
} from "./files.js";
import { cancelJobInPod, execJobInPod, pollJobInPod } from "./jobs.js";
import {
  applySandbox,
  deleteSandbox,
  getSandbox,
  livePodImageDiffers,
  podDeleteApiAdapter,
  resolvePodName,
  SANDBOX_KIND,
  sandboxStatus,
  setOperatingMode,
  type SandboxCustomObjectsApi,
  type SandboxPodDeleteApi,
  type SandboxPodsApi,
  type SandboxPodStatusApi,
} from "./lifecycle.js";
import { buildSandboxManifest, credsSecretName, SANDBOX_CONTAINER_NAME, sandboxCrName } from "./manifest.js";
import type { K8sProviderConfig } from "./types.js";

/** How long `create()`/`restore()` polls for the CR to reach `Ready` before
 * giving up. Generous relative to Task 3's empirical ~15s pod-recreate
 * observation, since a from-scratch `create` also pays image-pull latency
 * on top of that. Mirrors the engine's own `SANDBOX_READY_TIMEOUT_MS`
 * default (60s, `packages/engine/src/sandbox/policy.ts`) rather than
 * importing it, since this module has no dependency on the policy layer. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 1_000;

/** Port the in-sandbox auth gateway daemon listens on (Task 2 default). */
const GATEWAY_PORT = 9000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pod liveness (mirrors sandbox-docker's `isContainerAlive`) ─────────

/** Minimal pod-liveness query — the k8s analog of docker's
 * `docker inspect -f '{{.State.Running}}'`. Deliberately NOT folded into
 * `lifecycle.ts`'s `SandboxPodsApi` (that interface is scoped to
 * `resolvePodName`'s ownerReference-scan fallback, a CRD-adjacent concern);
 * this is plain `CoreV1Api` pod-status polling, the same layer
 * `sandbox-docker`'s liveness check lives at (directly in `sandbox.ts`, not
 * a separate lifecycle module).
 *
 * Returns `metadata.uid`, not `status.phase` — empirically (live-cluster
 * probe, see provider.ts's death-detection docblock above), a Kubernetes
 * pod's `status.phase` stays `"Running"` throughout a `kubectl delete pod`
 * (there is no distinct "Terminating" *phase* value — only a
 * `metadata.deletionTimestamp`), AND the agent-sandbox controller
 * reconciles a brand-new pod under the exact same NAME within seconds
 * (Task 3's finding). A phase-only check can observe the *new* pod as
 * "Running" moments after the *old* one died and wrongly conclude nothing
 * happened. Comparing `uid` (immutable per pod object, changes on every
 * recreate) against a baseline captured at dispatch time is the only
 * reliable "is this still the pod I dispatched against" signal. */
export interface PodLivenessApi {
  /** Returns the pod's current `metadata.uid`, or `null` if the pod does
   * not exist (a 404 from the API server). */
  getPodUid(namespace: string, podName: string): Promise<string | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(err: unknown): boolean {
  return isRecord(err) && typeof err.code === "number" && err.code === 404;
}

/** Wraps a real `k8s.CoreV1Api` instance. */
export function podLivenessApiAdapter(api: k8s.CoreV1Api): PodLivenessApi {
  return {
    async getPodUid(namespace, podName) {
      try {
        const pod = await api.readNamespacedPod({ name: podName, namespace });
        return pod.metadata?.uid ?? null;
      } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },
  };
}

/**
 * True when the failure looks like the process was killed by a signal
 * (exit code `128 + signal`), the same narrow band `sandbox-docker`'s
 * `looksSignalKilled` flags as worth an extra liveness round-trip before
 * deciding it's ordinary command behavior vs. transport failure. Exported
 * for unit testing.
 */
export function looksSignalKilled(exitCode: number): boolean {
  return exitCode > 128 && exitCode <= 128 + 64;
}

/** Best-effort extraction of a trailing `"(exit N)"` marker from an error
 * message (the shape both `PodFileOpError` and jobs.ts's kickoff-failure
 * `Error` use). Returns `undefined` when no such marker is present. */
function extractExitCodeFromMessage(message: string): number | undefined {
  const match = /\(exit (\d+)\)/.exec(message);
  return match ? Number(match[1]) : undefined;
}

/** execId format guard (carried forward from Task 4 review): generated
 * execIds are provider-owned counters, never user input, but this is
 * asserted defensively anyway so a malformed id can never be interpolated
 * into a `/tmp/valet-jobs/{execId}.*` path and traverse out of that
 * directory (no `/`, no `.`, no whitespace). Exported for unit testing. */
const EXEC_ID_PATTERN = /^job-[0-9]+$/;

export function assertSafeExecId(execId: string): void {
  if (!EXEC_ID_PATTERN.test(execId)) {
    throw new Error(`invalid execId ${JSON.stringify(execId)}: expected to match ${EXEC_ID_PATTERN}`);
  }
}

/** Builds the transport-failure-shaped `Error` PolicySandbox's
 * `CONTAINER_DEATH_PATTERN` match expects — "is not running" is one of the
 * pattern's literal alternatives. */
function podUnavailableError(sandboxId: string, detail: string): Error {
  return new Error(`No such container: sandbox "${sandboxId}" is not running (${detail})`);
}

/** Narrow interface over CoreV1Api for per-sandbox creds Secret lifecycle.
 * Whole-directory Secrets only — no subPath, no env-from-secret (both break
 * live kubelet updates). */
export interface SandboxSecretsApi {
  /** Create or replace a Secret. Creates on the first call; on 409 (already
   * exists) fetches `resourceVersion` via GET and then replaces. The GET is
   * required so the server accepts the PUT (optimistic concurrency). */
  upsertSecret(namespace: string, name: string, data: Record<string, string>): Promise<void>;
  /** Write (create or replace) Secret data. Replaces an existing Secret; on
   * 404 (Secret missing — e.g. a sandbox predating this feature, or a
   * manually deleted Secret) creates it instead. The kubelet propagates the
   * change into mounted volumes automatically — no pod restart required. */
  writeSecret(namespace: string, name: string, data: Record<string, string>): Promise<void>;
  /** Delete a Secret. Tolerates 404 (already deleted). */
  deleteSecret(namespace: string, name: string): Promise<void>;
  /** Best-effort: set the Secret's single `ownerReference` to the Sandbox CR
   * (by name + uid) so an external CR delete garbage-collects the Secret.
   * Idempotent — patching an already-set ownerReference is a no-op. Tolerates
   * 404 (Secret gone). Every other failure is the caller's to swallow. */
  patchOwnerReference(
    namespace: string,
    name: string,
    owner: { apiVersion: string; kind: string; name: string; uid: string },
  ): Promise<void>;
}

/** Encodes Secret data values to base64, as Kubernetes requires for `.data`. */
function encodeSecretData(data: Record<string, string>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    encoded[key] = Buffer.from(value, "utf8").toString("base64");
  }
  return encoded;
}

/** Production adapter: wraps a real `k8s.CoreV1Api` instance for Secret
 * create/write/delete. `upsertSecret` uses create-then-replace-on-409 to
 * avoid server-side apply requirements; it GETs `resourceVersion` before
 * replace so the optimistic-concurrency check passes. `writeSecret` replaces
 * an existing Secret and falls back to create on 404. */
export function sandboxSecretsApiAdapter(api: k8s.CoreV1Api): SandboxSecretsApi {
  return {
    async upsertSecret(namespace, name, data) {
      const encodedData = encodeSecretData(data);
      const baseBody = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name, namespace },
        data: encodedData,
      };
      try {
        await api.createNamespacedSecret({ namespace, body: baseBody });
      } catch (err) {
        // 409 = already exists — fetch resourceVersion then replace.
        if (!isRecord(err) || typeof err.code !== "number" || err.code !== 409) {
          throw err;
        }
        const existing = await api.readNamespacedSecret({ name, namespace });
        const resourceVersion = existing.metadata?.resourceVersion;
        await api.replaceNamespacedSecret({
          name,
          namespace,
          body: {
            ...baseBody,
            metadata: { name, namespace, resourceVersion },
          },
        });
      }
    },
    async writeSecret(namespace, name, data) {
      const encodedData = encodeSecretData(data);
      try {
        // Try to replace the existing Secret first. The GET for resourceVersion
        // is needed for optimistic concurrency.
        const existing = await api.readNamespacedSecret({ name, namespace });
        const resourceVersion = existing.metadata?.resourceVersion;
        await api.replaceNamespacedSecret({
          name,
          namespace,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name, namespace, resourceVersion },
            data: encodedData,
          },
        });
      } catch (err) {
        // 404 = Secret does not exist yet (e.g. sandbox created before this
        // feature, or Secret was manually deleted). Create it instead.
        if (!isRecord(err) || typeof err.code !== "number" || err.code !== 404) {
          throw err;
        }
        await api.createNamespacedSecret({
          namespace,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name, namespace },
            data: encodedData,
          },
        });
      }
    },
    async deleteSecret(namespace, name) {
      try {
        await api.deleteNamespacedSecret({ name, namespace });
      } catch (err) {
        if (isRecord(err) && typeof err.code === "number" && err.code === 404) {
          return;
        }
        throw err;
      }
    },
    async patchOwnerReference(namespace, name, owner) {
      // Strategic-merge patch of just the ownerReferences array. A
      // whole-array set is idempotent: re-patching the same single owner is a
      // no-op. Tolerates 404 (Secret already gone).
      try {
        await api.patchNamespacedSecret(
          {
            name,
            namespace,
            body: {
              metadata: {
                ownerReferences: [
                  {
                    apiVersion: owner.apiVersion,
                    kind: owner.kind,
                    name: owner.name,
                    uid: owner.uid,
                  },
                ],
              },
            },
          },
          setHeaderOptions("Content-Type", "application/merge-patch+json"),
        );
      } catch (err) {
        if (isRecord(err) && typeof err.code === "number" && err.code === 404) {
          return;
        }
        throw err;
      }
    },
  };
}

export interface KubernetesSandboxDeps {
  objectsApi: SandboxCustomObjectsApi;
  podsApi: SandboxPodsApi;
  execApi: PodExecApi;
  livenessApi: PodLivenessApi;
  cfg: K8sProviderConfig;
}

/**
 * `Sandbox` implementation over a single Sandbox CR's backing pod. Every
 * operation re-resolves the pod name fresh (never caches it across calls —
 * decision 5's exec-targeting note: the controller mints a fresh pod object
 * after pod-level recovery, same name string but a new backing pod).
 */
export class KubernetesSandbox implements Sandbox {
  readonly id: string;
  private readonly deps: KubernetesSandboxDeps;
  private nextJobId = 1;

  constructor(deps: KubernetesSandboxDeps, id: string) {
    this.deps = deps;
    this.id = id;
  }

  private execDeps(): ExecDeps {
    return { api: this.deps.execApi, namespace: this.deps.cfg.namespace, containerName: SANDBOX_CONTAINER_NAME };
  }

  private nextExecId(): string {
    return `job-${this.nextJobId++}`;
  }

  /** Resolves the current backing pod name PLUS its `uid` baseline (the
   * `uid` is captured here, at dispatch time, so a later signal-killed
   * exit can tell "the pod I ran against was recreated/removed" apart from
   * "a process inside the still-alive pod was killed" — see
   * `PodLivenessApi`'s docblock for why `uid`, not `status.phase`). Throws
   * a transport-failure-shaped Error (see `podUnavailableError`) when the
   * CR is gone or has no backing pod yet/anymore. */
  private async resolvePodContext(): Promise<{ podName: string; uid: string | null }> {
    const podName = await resolvePodName(this.deps.objectsApi, this.deps.podsApi, this.deps.cfg, this.id);
    if (podName === null) {
      throw podUnavailableError(this.id, "no backing pod");
    }
    const uid = await this.deps.livenessApi.getPodUid(this.deps.cfg.namespace, podName);
    return { podName, uid };
  }

  /** True when the pod identified by `podName` is no longer the SAME pod
   * object `dispatchUid` was captured from — either it's gone entirely, or
   * a fresh pod (new uid) now answers to that name. A `null` `dispatchUid`
   * (uid lookup itself raced the dispatch) never reports "died" — a
   * missing baseline can't prove death, so this stays best-effort rather
   * than a false positive. */
  private async podDiedSince(podName: string, dispatchUid: string | null): Promise<boolean> {
    if (dispatchUid === null) return false;
    const currentUid = await this.deps.livenessApi.getPodUid(this.deps.cfg.namespace, podName);
    return currentUid === null || currentUid !== dispatchUid;
  }

  /**
   * Classifies a rejection from `op`: a message already matching
   * `CONTAINER_DEATH_PATTERN` passes through unchanged (nothing further to
   * do — PolicySandbox will catch it). A `PodFileOpError`/generic error
   * whose (best-effort-extracted) exit code looks signal-killed is
   * confirmed against `podDiedSince` before being translated — never
   * trusted outright, matching docker's `looksSignalKilled` +
   * `isContainerAlive` disambiguation (a legitimate in-pod `kill -9 $$`
   * must NOT be misreported as sandbox death). Anything else rethrows
   * unchanged (a genuine application-level failure, e.g. `PodFileOpError`
   * for a missing file).
   */
  private async translateDeath(podName: string, dispatchUid: string | null, err: unknown): Promise<never> {
    const error = err instanceof Error ? err : new Error(String(err));
    if (CONTAINER_DEATH_PATTERN.test(error.message)) throw error;

    // PodFileOpError carries its exit code as a typed field; jobs.ts's
    // kickoff-failure Error ("execJob kickoff failed (exit N): ...", see
    // ./jobs.ts's execJobInPod) embeds it in the message text only — the
    // trailing "(exit N)" extraction covers that shape generically without
    // requiring jobs.ts to grow its own typed error class.
    const exitCode =
      error instanceof PodFileOpError ? error.exitCode : extractExitCodeFromMessage(error.message);
    if (exitCode === undefined || !looksSignalKilled(exitCode)) throw error;

    const died = await this.podDiedSince(podName, dispatchUid);
    if (!died) throw error;
    throw podUnavailableError(this.id, `${error.message} — backing pod was recreated or removed`);
  }

  /** Resolve the pod (capturing its dispatch-time `uid`), run `op` against
   * it, and translate any death signal (thrown OR — for callers that check
   * the return value themselves, e.g. `exec()`'s `ExecResult.exitCode` —
   * left to the caller via `checkExitForDeath`) into the transport-failure
   * shape the attachment layer expects. */
  private async withPodContext<T>(op: (ctx: { podName: string; uid: string | null }) => Promise<T>): Promise<T> {
    const ctx = await this.resolvePodContext();
    try {
      return await op(ctx);
    } catch (err) {
      return this.translateDeath(ctx.podName, ctx.uid, err);
    }
  }

  private async withPod<T>(op: (podName: string) => Promise<T>): Promise<T> {
    return this.withPodContext((ctx) => op(ctx.podName));
  }

  /** Checks a resolved `ExecResult`/`JobPoll` exit code for a signal-killed
   * shape and, if the backing pod has actually been recreated/removed
   * since dispatch, throws the transport-failure error instead of letting
   * a misleading "the command exited 137" result flow back as a normal
   * outcome. No-op (returns) when the exit code isn't signal-shaped or the
   * pod is unchanged. */
  private async checkExitForDeath(podName: string, dispatchUid: string | null, exitCode: number | undefined): Promise<void> {
    if (exitCode === undefined || !looksSignalKilled(exitCode)) return;
    const died = await this.podDiedSince(podName, dispatchUid);
    if (!died) return;
    throw podUnavailableError(this.id, `exec exited ${exitCode} — backing pod was recreated or removed`);
  }

  async readFile(path: string): Promise<string> {
    return this.withPod((pod) => readFileInPod(this.execDeps(), pod, path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return this.withPod((pod) => readBinaryInPod(this.execDeps(), pod, path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.withPod((pod) => writeFileInPod(this.execDeps(), pod, path, content));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    return this.withPod((pod) => writeBinaryInPod(this.execDeps(), pod, path, data));
  }

  async readdir(path: string): Promise<string[]> {
    return this.withPod((pod) => readdirInPod(this.execDeps(), pod, path));
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    return this.withPod((pod) => statInPod(this.execDeps(), pod, path));
  }

  async mkdir(path: string): Promise<void> {
    return this.withPod((pod) => mkdirInPod(this.execDeps(), pod, path));
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.withPod((pod) => rmInPod(this.execDeps(), pod, path, opts));
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    return this.withPodContext(async ({ podName, uid }) => {
      const result = await execInPod(this.execDeps(), podName, command, opts);
      if (!result.timedOut) await this.checkExitForDeath(podName, uid, result.exitCode);
      return result;
    });
  }

  // `snapshot` is intentionally NOT implemented — `capabilities().snapshot`
  // is `"none"` (decision 5), and `Sandbox.snapshot` is optional precisely
  // so a provider without the capability can omit it rather than fake a
  // value or throw.

  async tunnels(): Promise<Record<string, string>> {
    return {};
  }

  // `destroy` is intentionally NOT implemented on this class. Destroy
  // semantics for a Sandbox CR are TERMINAL (decision 5) and must live on
  // the PROVIDER only (`KubernetesSandboxProvider.destroy`, the CR+PVC
  // cascade delete). `Sandbox.destroy` is optional precisely so a provider
  // can omit it: `SandboxAttachment.destroy` (session deletion) falls back
  // to `provider.destroy(id)` whenever the raw `Sandbox` has no `destroy`
  // method (see attachment.ts) — that fallback is how the terminal delete
  // actually fires. Defining a `destroy()` here (even a no-op) would
  // short-circuit that fallback and leak the CR/pod/PVC on every session
  // deletion forever. Non-terminal recovery (`reportFailure`) never touches
  // `Sandbox.destroy` at all — it calls `provider.release`/`provider.destroy`
  // directly (see `KubernetesSandboxProvider.release`, below).

  async execJob(command: string, opts?: ExecOpts): Promise<ExecJobHandle> {
    const execId = this.nextExecId();
    return this.withPod(async (pod) => {
      const handle = await execJobInPod(this.execDeps(), pod, execId, command, opts);
      return handle;
    });
  }

  async pollJob(execId: string, offset: number): Promise<JobPoll> {
    assertSafeExecId(execId);
    return this.withPodContext(async ({ podName, uid }) => {
      const poll = await pollJobInPod(this.execDeps(), podName, execId, offset);
      if (poll.status === "done") await this.checkExitForDeath(podName, uid, poll.exitCode);
      return poll;
    });
  }

  async cancelJob(execId: string): Promise<void> {
    assertSafeExecId(execId);
    return this.withPod((pod) => cancelJobInPod(this.execDeps(), pod, execId));
  }

  /**
   * The in-sandbox auth gateway's reachable endpoint (Task 3). Returns
   * `null` when this CR never requested a Service (`spec.service` unset —
   * the headless-profile case) or when the controller hasn't reconciled
   * `status.serviceFQDN` yet. GETs the CR fresh rather than caching —
   * mirrors every other accessor on this class (`resolvePodContext` etc.),
   * consistent with decision 5's "never cache pod/CR state across calls".
   */
  async gatewayEndpoint(): Promise<GatewayEndpoint | null> {
    const cr = await getSandbox(this.deps.objectsApi, this.deps.cfg, this.id);
    if (cr === null || !cr.spec.service) return null;
    const serviceFQDN = cr.status?.serviceFQDN;
    if (!serviceFQDN) return null;
    return { host: serviceFQDN, port: GATEWAY_PORT };
  }
}

// ── Provider ─────────────────────────────────────────────────────────

export interface KubernetesSandboxProviderDeps {
  objectsApi: SandboxCustomObjectsApi;
  podsApi: SandboxPodsApi;
  execApi: PodExecApi;
  livenessApi: PodLivenessApi;
  /** Optional: enables `status()`/`waitReady`'s pod-failure classification
   * (see `lifecycle.ts`'s `sandboxStatus`/`classifyPodFailure`). Omitting it
   * falls back to the CR-Ready-only mapping (pre-fix behavior) — kept
   * optional so existing callers/tests that don't need the fast-fail
   * behavior aren't forced to wire a new dep. Production wiring
   * (`packages/api/src/providers/sandbox-backend.ts`) always supplies it. */
  podStatusApi?: SandboxPodStatusApi;
  /** Optional: enables `create()`'s image-drift convergence path — when the
   * live pod's image differs from the manifest image, the pod is deleted so
   * the controller reconciles a fresh one. Omitting it disables the drift
   * check (pre-task-8 behavior). Production wiring always supplies it. */
  podDeleteApi?: SandboxPodDeleteApi;
  /** Optional: enables credsMount — create/patch/delete the per-sandbox
   * creds Secret. When absent, credsFiles in SandboxCreateOpts is ignored. */
  secretsApi?: SandboxSecretsApi;
}

export class KubernetesSandboxProvider implements SandboxProvider {
  readonly backend = "kubernetes";
  private readonly deps: KubernetesSandboxProviderDeps;
  private readonly cfg: K8sProviderConfig;

  constructor(deps: KubernetesSandboxProviderDeps, cfg: K8sProviderConfig) {
    this.deps = deps;
    this.cfg = cfg;
  }

  /** Spec decision 5's capabilities constant. `persistentWorkspace: true`
   * is honest under these semantics because recovery/re-provision always
   * rides `applySandbox`/pod-recreate under the retained CR — never
   * destroy+create — so the workspace PVC survives every non-terminal
   * failure path. */
  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: true,
      customImage: true,
      isolated: true,
      coldStartEstimateMs: 8000,
      // Only advertise credsMount when secretsApi is wired. A provider
      // constructed without secretsApi cannot honor updateCreds().
      credsMount: Boolean(this.deps.secretsApi),
      dockerSupport: true,
    };
  }

  /** Upsert-shaped (decision 5, NON-NEGOTIABLE): `applySandbox` adopts an
   * existing CR of the same name rather than erroring, so the attachment
   * layer's failure-recovery path (which calls `create()` again with the
   * same opts after `reportFailure`) never fails on "already exists".
   *
   * Image-drift convergence (Task 8): after `applySandbox`, if a live pod
   * exists whose first container image differs from the manifest image, this
   * method deletes that pod. The agent-sandbox controller then reconciles a
   * fresh pod from the updated CR spec. This method proceeds to `waitReady`
   * the same way a cold create does — the controller recreates the pod under
   * the same name, so the label-selector-based readiness poll is unaffected
   * by the pod name. The workspace PVC is retained (decision 5). */
  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    if (!opts.workspace) {
      throw new Error(
        "KubernetesSandboxProvider.create: opts.workspace is required " +
          "(used as the session-identity input to the deterministic CR name — see provider.ts's module docblock).",
      );
    }
    const name = sandboxCrName(opts.workspace);
    const manifest = buildSandboxManifest(this.cfg, name, opts);

    // Upsert creds Secret BEFORE applying the Sandbox CR — the pod scheduler
    // reads the volume reference at start; the Secret must exist first.
    if (opts.credsFiles && Object.keys(opts.credsFiles).length > 0 && !this.deps.secretsApi) {
      console.error(
        `k8s sandbox ${name}: credsFiles provided but secretsApi is not wired — creds mount will be empty`,
      );
    }
    if (this.deps.secretsApi && opts.credsFiles && Object.keys(opts.credsFiles).length > 0) {
      await this.deps.secretsApi.upsertSecret(this.cfg.namespace, credsSecretName(name), opts.credsFiles);
    }

    const applied = await applySandbox(this.deps.objectsApi, this.cfg, manifest);

    // Best-effort: adopt the creds Secret under the Sandbox CR so an external CR
    // delete garbage-collects the Secret. Never fatal — the terminal
    // `destroy()` path also deletes the Secret explicitly, so a failed patch
    // only forgoes GC-on-external-delete, not correctness.
    if (this.deps.secretsApi && opts.credsFiles && Object.keys(opts.credsFiles).length > 0) {
      await this.adoptCredsSecret(name, applied.metadata.uid);
    }

    if (this.deps.podDeleteApi && this.deps.podStatusApi) {
      const manifestImage = (opts.image ?? this.cfg.defaultImage) as string;
      const check = await livePodImageDiffers(
        this.deps.objectsApi,
        this.deps.podsApi,
        this.deps.podStatusApi,
        this.cfg,
        name,
        manifestImage,
      );
      if (check.differs) {
        console.log(`k8s sandbox ${name}: rolling pod (image ${check.liveImage} → ${manifestImage})`);
        // Capture the old pod UID before deletion so the wait-for-fresh loop
        // below can detect when the controller has reconciled a NEW pod object
        // (same name, new UID) — rather than racing against a stale
        // `Ready=True` CR condition left over from the deleted pod.
        const oldUid = await this.deps.livenessApi.getPodUid(this.cfg.namespace, check.podName);
        await this.deps.podDeleteApi.deletePod(this.cfg.namespace, check.podName);
        // Wait for the controller to reconcile a fresh pod (new UID). This
        // mirrors the conformance suite's `recreate` callback logic. Without
        // this wait, `waitReady` could observe a stale `Ready=True` CR
        // condition from the just-deleted pod and return prematurely.
        const podRollDeadline = Date.now() + READY_TIMEOUT_MS;
        for (;;) {
          const newUid = await this.deps.livenessApi.getPodUid(this.cfg.namespace, check.podName);
          if (newUid !== null && newUid !== oldUid) break;
          if (Date.now() >= podRollDeadline) {
            throw new Error(
              `k8s sandbox ${name}: controller did not reconcile a fresh pod within ${READY_TIMEOUT_MS}ms after image-drift roll`,
            );
          }
          await sleep(READY_POLL_INTERVAL_MS);
        }
      }
    }

    await this.waitReady(name);
    return this.makeSandbox(name);
  }

  /** Re-asserts (GETs) the same CR name — never creates. The engine
   * persists `sandboxId` (== the CR name) and calls this at boot; unlike
   * `sandbox-docker`'s in-memory `Map` (which does not survive an api
   * restart), this provider is cluster-backed and needs no local registry. */
  async restore(id: string): Promise<Sandbox> {
    const cr = await getSandbox(this.deps.objectsApi, this.cfg, id);
    if (cr === null) {
      throw new Error(`KubernetesSandboxProvider.restore: Sandbox CR "${id}" not found`);
    }
    return this.makeSandbox(id);
  }

  /** TERMINAL (decision 5, NON-NEGOTIABLE): deletes the CR, cascading to
   * pod + PVC via the controller's owner references. Only the
   * session-deletion path may call this. Also deletes the creds Secret
   * best-effort — a missing Secret (sandbox never had one) is not an error.
   *
   * `id` must be the Sandbox CR name (i.e. `sandbox.id` / the value returned
   * by `create()`), not the raw workspace key. */
  async destroy(id: string): Promise<void> {
    // Best-effort: delete the creds Secret before the CR (or concurrently).
    // A missing Secret is fine — the sandbox may never have had one.
    if (this.deps.secretsApi) {
      await this.deps.secretsApi.deleteSecret(this.cfg.namespace, credsSecretName(id)).catch(() => {});
    }
    await deleteSandbox(this.deps.objectsApi, this.cfg, id);
  }

  /** NON-terminal (decision 5, NON-NEGOTIABLE): a no-op that leaves the CR
   * (and its owner-referenced pod + workspace PVC) standing. This is the
   * seam `SandboxAttachment.reportFailure` calls in preference to `destroy`
   * (see `packages/engine/src/types.ts`'s `SandboxProvider.release` and
   * `packages/engine/src/sandbox/attachment.ts`'s `reportFailure`) — the
   * subsequent `create()` call (upsert-shaped, same CR name) re-adopts the
   * retained CR and the controller heals a fresh pod onto the retained PVC,
   * so the workspace survives a liveness-triggered re-provision instead of
   * being cascade-deleted the way an unconditional `destroy` would. Verifies
   * (does not create) the CR still exists and logs when it's unexpectedly
   * already gone — that's a legitimate race (e.g. a concurrent `destroy`)
   * this method must never treat as an error, since it makes no state
   * change of its own. */
  async release(id: string): Promise<void> {
    const cr = await getSandbox(this.deps.objectsApi, this.cfg, id);
    if (cr === null) {
      // Already gone (e.g. raced a concurrent terminal `destroy`) — nothing
      // to release, and this must not throw: `reportFailure`'s caller
      // treats `release`/`destroy` as fire-and-forget best-effort.
      console.warn(`KubernetesSandboxProvider.release: Sandbox CR "${id}" was already gone`);
    }
  }

  async status(id: string): Promise<SandboxStatus> {
    return sandboxStatus(this.deps.objectsApi, this.cfg, id, this.deps.podsApi, this.deps.podStatusApi);
  }

  /**
   * Hibernation seam (Task 2, paired with `capabilities().hibernation`).
   * Merge-patches `spec.operatingMode: Suspended` — the controller reacts by
   * scaling the backing pod to zero while retaining the CR and its
   * owner-referenced workspace PVC (never a delete). Idempotent: patching an
   * already-suspended CR is a no-op re-apply of the same merge, matching
   * `setOperatingMode`'s contract. Does NOT wait for the pod to actually
   * disappear — `status()` (via `sandboxStatus`'s Suspended short-circuit)
   * reflects the CR's intent immediately regardless of how long the
   * controller takes to tear the pod down.
   */
  async suspend(id: string): Promise<void> {
    await setOperatingMode(this.deps.objectsApi, this.cfg, id, "Suspended");
  }

  /**
   * Wakes a suspended CR. Merge-patches `spec.operatingMode: Running`, then
   * polls (via `waitReady`, the same helper `create()` uses) until the
   * controller has reconciled a fresh backing pod and it reaches Ready —
   * this method does NOT return early. This matters because the engine's
   * `SandboxAttachment.doResume` (`packages/engine/src/sandbox/
   * attachment.ts`) awaits `provider.resume(id)` and immediately marks the
   * attachment `ready` on return, with no readiness poll of its own — it
   * relies entirely on `provider.create()`/`provider.resume()` not
   * resolving until the sandbox is actually usable (the same contract
   * `create()` already honors via its own `waitReady` call after
   * `applySandbox`). Idempotent: patching an already-Running CR just
   * re-applies the same merge and `waitReady` returns immediately since the
   * CR is already Ready.
   */
  async resume(id: string): Promise<void> {
    await setOperatingMode(this.deps.objectsApi, this.cfg, id, "Running");
    await this.waitReady(id);
  }

  /** Writes updated credential files into a running sandbox. Replaces the
   * creds Secret — the kubelet propagates the change into the mounted volume
   * without a pod restart. On 404 (Secret missing, e.g. a sandbox created
   * before this feature) creates the Secret instead. Requires secretsApi
   * wired.
   *
   * `id` must be the Sandbox CR name (i.e. `sandbox.id` / the value returned
   * by `create()`), not the raw workspace key. */
  async updateCreds(id: string, files: Record<string, string>): Promise<void> {
    if (!this.deps.secretsApi) {
      throw new Error(`KubernetesSandboxProvider.updateCreds: secretsApi not wired (sandbox "${id}")`);
    }
    await this.deps.secretsApi.writeSecret(this.cfg.namespace, credsSecretName(id), files);
    // Best-effort: adopt the Secret under the Sandbox CR. writeSecret's
    // 404-create path (a pre-feature or manually-deleted Secret) makes a fresh
    // Secret with no ownerReference; the CR exists at this point (updateCreds is
    // only ever called against a live sandbox), so fetch its uid and patch the
    // ownerReference for GC-on-external-delete. Idempotent for the replace path.
    // Never fatal.
    try {
      const cr = await getSandbox(this.deps.objectsApi, this.cfg, id);
      await this.adoptCredsSecret(id, cr?.metadata.uid);
    } catch (err) {
      console.error(`k8s sandbox ${id}: updateCreds ownerReference adopt failed (non-fatal)`, err);
    }
  }

  /**
   * Best-effort: patch the creds Secret's ownerReference to the Sandbox CR
   * named `crName` so an external CR delete garbage-collects the Secret.
   * `uid` is the CR's `metadata.uid`. A missing `uid` or `secretsApi`, or any
   * patch failure, is logged and swallowed — never fatal (the terminal
   * `destroy()` path deletes the Secret explicitly regardless).
   */
  private async adoptCredsSecret(crName: string, uid: string | undefined): Promise<void> {
    if (!this.deps.secretsApi || !uid) return;
    try {
      await this.deps.secretsApi.patchOwnerReference(this.cfg.namespace, credsSecretName(crName), {
        apiVersion: this.cfg.apiVersion,
        kind: SANDBOX_KIND,
        name: crName,
        uid,
      });
    } catch (err) {
      console.error(`k8s sandbox ${crName}: creds Secret ownerReference patch failed (non-fatal)`, err);
    }
  }

  private makeSandbox(id: string): KubernetesSandbox {
    return new KubernetesSandbox(
      {
        objectsApi: this.deps.objectsApi,
        podsApi: this.deps.podsApi,
        execApi: this.deps.execApi,
        livenessApi: this.deps.livenessApi,
        cfg: this.cfg,
      },
      id,
    );
  }

  /**
   * Polls `sandboxStatus` until `ready` (or `error`/timeout). The engine's
   * `SandboxAttachment` treats a resolved `provider.create()` as
   * immediately ready (it does not itself poll `status()` post-create — see
   * `packages/engine/src/sandbox/attachment.ts`'s `doProvision`), so this
   * provider must not return until the CR has actually reconciled.
   *
   * `state: "error"` is a FAST FAIL: `sandboxStatus` (when `podStatusApi` is
   * wired) classifies terminal pod failures — `ImagePullBackOff`,
   * `CrashLoopBackOff`, `PodFailed`, `Unschedulable` — as `error` within a
   * few poll intervals of the failure actually occurring, well under
   * `READY_TIMEOUT_MS`. That's thrown as `SandboxStartupError` (a definite,
   * non-retryable startup failure carrying the specific cause), NOT the
   * generic timeout error below — `SandboxAttachment.doProvision` branches
   * on that distinction to reject pending `ensureReady` waiters immediately
   * with the real cause instead of leaving them to hit their own 60s
   * timeout and see a misleading "retry shortly" message. The deadline
   * branch (no `error` state ever observed, just genuinely slow) keeps
   * throwing a plain `Error` — that IS a transient, retry-shaped condition.
   */
  private async waitReady(name: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const status = await sandboxStatus(this.deps.objectsApi, this.cfg, name, this.deps.podsApi, this.deps.podStatusApi);
      if (status.state === "ready") return;
      if (status.state === "error") {
        throw new SandboxStartupError(name, status.error ?? "unknown");
      }
      if (Date.now() >= deadline) {
        throw new Error(`Sandbox CR "${name}" did not become ready within ${READY_TIMEOUT_MS}ms (state: ${status.state})`);
      }
      await sleep(READY_POLL_INTERVAL_MS);
    }
  }
}
