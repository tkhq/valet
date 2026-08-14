import type {
  DesiredSandboxSpec,
  Sandbox,
  SandboxCreateOpts,
  SandboxProvider,
  SpecProvider,
} from "../types.js";
import { markSpanError, withSpan } from "../tracing.js";
import { recordSandboxProvision } from "../metrics.js";
import {
  SandboxPreparationError,
  SandboxStartupError,
  SandboxUnavailableError,
  WorkspaceProvisioningError,
} from "../errors.js";
import { type AppliedState, applyPlan, diffSteps, readAppliedState } from "./applied-state.js";

/**
 * Max age of a cached observation before `reconcile` re-reads the applied-state
 * file from the sandbox (spec decision 4 throttle). A `reconcile` inside this
 * window trusts the in-memory cache and runs no observation exec.
 */
export const OBSERVE_TTL_MS = 5 * 60_000;

/** Max backoff between failed image-replacement retries (spec decision 6). */
const REPLACE_BACKOFF_CAP_MS = 30 * 60_000;

/** A cached observation of what the live sandbox has applied (spec decision 4). */
interface ObservationCache {
  applied: AppliedState;
  at: number;
  /** Epoch the observation belongs to — a re-provision invalidates it. */
  epoch: number;
}

/**
 * Memo of the most recent failed image replacement (spec decision 6). A
 * `reconcile` whose desired spec hashes to `specHash` skips the replace while
 * inside the exponential backoff window from `failedAt`.
 */
interface ConvergeFailure {
  specHash: string;
  failedAt: number;
  attempts: number;
}

/**
 * Attachment lifecycle states (spec decision 2). `detached` = never
 * provisioned; `provisioning` = a `provider.create` is in flight;
 * `ready` = a live raw `Sandbox` is attached; `error` = provisioning
 * failed or (for `forSandbox` attachments) a reported failure with no
 * provider to recover with; `suspended` = hibernated via `suspend()` (workspace
 * retained, sandbox scaled to zero) — the raw handle is kept so `resume` wakes
 * it under the same id and epoch; `released` = `destroy()` was called — terminal.
 */
export type AttachmentState = "detached" | "provisioning" | "ready" | "suspended" | "error" | "released";

export interface AttachmentStatus {
  state: AttachmentState;
  sandboxId?: string;
  epoch: number;
  estimateMs?: number;
  /**
   * Suspend/resume cycle counter (engine-internal). 0 for a never-suspended
   * attachment; incremented on each `suspend()`. The epoch is deliberately NOT
   * bumped by a clean suspend/resume, so a wake re-emits the SAME
   * epoch's `provisioning`/`ready` — which would collide with the cold-boot
   * status events on their durable `sandbox:{epoch}:{state}` eventKey. Callers
   * building that key (see `Session`) use `wake` to disambiguate wake
   * transitions from the cold boot. Not forwarded to the wire shape.
   */
  wake?: number;
}

type StatusListener = (status: AttachmentStatus) => void;
type Unsubscribe = () => void;

interface Waiter {
  resolve: (v: { sandbox: Sandbox; epoch: number }) => void;
  reject: (err: unknown) => void;
}

/**
 * Engine-owned sandbox attachment state machine (spec decision 2). Owns the
 * raw `Sandbox` handle and a monotonic epoch. `PolicySandbox` is the
 * `Sandbox`-shaped wrapper that drives ops through this state machine.
 */
export class SandboxAttachment {
  private provider: SandboxProvider | null;
  // Not readonly: reconcile persists the reconciled image into createOpts so a
  // later cold re-provision (failure recovery) boots the observed image (spec
  // decision 9 — observed image is the source of truth).
  private createOpts: SandboxCreateOpts;
  private readonly specProvider: SpecProvider | undefined;
  private readonly estimateMs: number | undefined;
  private noProvider: boolean;

  private _state: AttachmentState = "detached";
  private _epoch = 0;
  private _wakeCount = 0;
  private _sandbox: Sandbox | null = null;
  private destroyed = false;
  private inFlight: Promise<void> | null = null;
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<StatusListener>();

  /** Cached observation of what the live sandbox has applied (spec decision 4). */
  private observation: ObservationCache | null = null;
  /** Single-flight guard for `reconcile` (spec decision 3). */
  private reconciling: Promise<void> | null = null;
  /** Backoff memo for a failed image replacement (spec decision 6). */
  private convergeFailure: ConvergeFailure | null = null;

  constructor(provider: SandboxProvider, createOpts: SandboxCreateOpts, specProvider?: SpecProvider) {
    this.provider = provider;
    this.createOpts = createOpts;
    this.specProvider = specProvider;
    this.estimateMs = provider.capabilities().coldStartEstimateMs;
    this.noProvider = false;
  }

  /**
   * Wraps a pre-existing concrete `Sandbox` (tests, embedders that already
   * have a live handle). Ready at epoch 1 with no provider — `reportFailure`
   * transitions it to `error` permanently since there is nothing to
   * re-provision with.
   */
  static forSandbox(sandbox: Sandbox): SandboxAttachment {
    const stubProvider: SandboxProvider = {
      backend: "none",
      capabilities: () => ({
        snapshot: "none",
        persistentWorkspace: false,
        tunnels: false,
        warmPool: false,
        hibernation: false,
        customImage: false,
      }),
      create: () => {
        throw new Error("SandboxAttachment.forSandbox: no provider available");
      },
      restore: () => {
        throw new Error("SandboxAttachment.forSandbox: no provider available");
      },
      destroy: () => {
        throw new Error("SandboxAttachment.forSandbox: no provider available");
      },
      status: () => {
        throw new Error("SandboxAttachment.forSandbox: no provider available");
      },
    };
    const attachment = new SandboxAttachment(stubProvider, {});
    attachment.provider = null;
    attachment.noProvider = true;
    attachment._sandbox = sandbox;
    attachment._epoch = 1;
    attachment._state = "ready";
    return attachment;
  }

  get state(): AttachmentState {
    return this._state;
  }

  get sandboxId(): string | undefined {
    return this._sandbox?.id;
  }

  /**
   * Peek the current raw `Sandbox` handle WITHOUT provisioning — `null`
   * unless the attachment is currently `ready`. Unlike `ensureReady`, this
   * never kicks a cold provision; it exists for read-only "is the sandbox
   * currently reachable" callers (sandbox auth gateway plan Task 6's
   * `gatewayEndpoint()` reverse proxy) that must NOT wake a hibernated or
   * detached sandbox just to check its status — that's the caller's
   * `wake`-then-retry job, signaled by this returning `null`.
   *
   * A `suspended` (hibernated) attachment returns `null` here even though it
   * still holds a raw handle: the sandbox is scaled to zero and not reachable
   * until `ensureReady`/`warm` drives the resume path.
   */
  current(): Sandbox | null {
    return this._state === "ready" ? this._sandbox : null;
  }

  /**
   * The backend's declared cold-start estimate (`SandboxCapabilities.coldStartEstimateMs`),
   * exposed so callers building a cold-turn hint (spec decision 7) don't need
   * their own handle on the provider. `forSandbox` attachments have no
   * provider and report `undefined`.
   */
  get coldStartEstimateMs(): number | undefined {
    return this.estimateMs;
  }

  currentEpoch(): number {
    return this._epoch;
  }

  isSuperseded(epoch: number): boolean {
    return epoch < this._epoch;
  }

  onStatus(cb: StatusListener): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Fire-and-forget, single-flight provision kick. No-op when already
   * ready, already provisioning, destroyed, or `forSandbox`-constructed. */
  warm(): void {
    if (this.destroyed || this.noProvider) return;
    if (this._state === "ready") return;
    this.kickProvision();
  }

  /**
   * Hibernate a ready sandbox (spec: idle scale-to-zero). Only meaningful from
   * `ready`: calls `provider.suspend(id)`, then transitions to `suspended`
   * KEEPING the raw handle so the id stays stable across suspend/resume. The
   * epoch is NOT bumped — a clean suspend/resume is not a re-provision, so ops
   * dispatched before hibernation are not superseded. From any other state this
   * resolves as a no-op WITHOUT touching the provider. If the provider does not
   * implement `suspend` (capability off), this throws — callers MUST gate on
   * `SandboxCapabilities.hibernation` first. On a `provider.suspend` rejection
   * the attachment stays `ready` and the error is rethrown.
   */
  async suspend(): Promise<void> {
    if (this._state !== "ready") return;
    const provider = this.provider;
    const sandbox = this._sandbox;
    // `forSandbox` / no live handle: nothing to hibernate, and no provider to
    // drive it with.
    if (!provider || !sandbox) return;
    if (!provider.suspend) {
      throw new Error("provider does not support hibernation");
    }
    // On rejection: state is untouched (still `ready`) and the error propagates.
    await provider.suspend(sandbox.id);
    // A concurrent destroy() during the await wins — do not resurrect it.
    if (this.destroyed) return;
    // Bump the suspend/resume cycle counter BEFORE emitting so this `suspended`
    // event and the wake's re-emitted `provisioning`/`ready` all carry a
    // wake-tag that disambiguates them from the cold-boot status events on the
    // same (deliberately-stable) epoch — otherwise they collide on the durable
    // eventKey and never reach the log or live subscribers.
    this._wakeCount += 1;
    this._state = "suspended";
    this.emitStatus();
  }

  /**
   * User-requested sandbox replacement: tear down the current sandbox and
   * re-provision a fresh one at a bumped epoch with the same persisted
   * `createOpts`. Mirrors the image-drift replace path in `doReconcile`
   * (epoch bump, handle drop, release-else-destroy) but is caller-driven.
   * Resolves once the re-provision settles; rejects when the attachment is
   * destroyed, has no provider, or a provision is already in flight.
   */
  async replace(): Promise<void> {
    if (this.destroyed) {
      throw new Error("sandbox attachment destroyed; the session is being torn down");
    }
    if (this.noProvider || !this.provider) {
      throw new Error("attachment has no provider; nothing to re-provision with");
    }
    if (this.inFlight || this._state === "provisioning") {
      throw new Error("sandbox is provisioning. Wait for it to finish, then retry.");
    }

    const oldSandbox = this._sandbox;
    const provider = this.provider;
    this._epoch += 1;
    this._sandbox = null;
    this.observation = null;
    this._state = "provisioning";
    if (oldSandbox) {
      void (provider.release
        ? provider.release(oldSandbox.id)
        : provider.destroy(oldSandbox.id)
      ).catch(() => {});
    }
    this.kickProvision();
    // Re-widen: the guard above narrowed `this.inFlight` to null and TS
    // keeps that narrowing across the kickProvision() call that re-set it
    // (same limitation the doReconcile state re-read works around).
    const pending = this.inFlight as Promise<void> | null;
    if (pending) await pending.catch(() => {});
  }

  /**
   * Await a ready sandbox, bounded by `opts.timeoutMs`. Kicks provisioning
   * if not already in flight. A timeout rejects the caller's wait only —
   * it does not change attachment state (a timeout is not degradation).
   */
  ensureReady(opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ sandbox: Sandbox; epoch: number }> {
    if (this.destroyed) {
      return Promise.reject(new SandboxUnavailableError(new Error("sandbox attachment destroyed")));
    }
    if (this._state === "ready" && this._sandbox) {
      return Promise.resolve({ sandbox: this._sandbox, epoch: this._epoch });
    }
    if (this._state === "error" && this.noProvider) {
      return Promise.reject(
        new SandboxUnavailableError(new Error("attachment has no provider and is in a permanent error state")),
      );
    }
    if (opts.signal?.aborted) {
      return Promise.reject(this.abortError(opts.signal));
    }

    this.kickProvision();

    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter: Waiter = {
        resolve: (v) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(e);
        },
      };

      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        waiter.reject(new WorkspaceProvisioningError(opts.timeoutMs));
      }, opts.timeoutMs);
      timer.unref?.();

      const onAbort = () => {
        this.waiters.delete(waiter);
        waiter.reject(this.abortError(opts.signal));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };

      this.waiters.add(waiter);
    });
  }

  /**
   * Degradation report (spec decision 2/3). When `epoch` names the current
   * epoch: marks it superseded (bumps the epoch immediately), best-effort
   * releases the old sandbox (`provider.release` when implemented, else
   * `provider.destroy` — see `SandboxProvider.release`'s doc), and kicks a
   * background re-provision. Stale reports (an old epoch that is no longer
   * current) are ignored — no state change, no extra `create`.
   */
  reportFailure(epoch: number, _err: unknown): void {
    if (this.destroyed) return;
    if (epoch !== this._epoch) return;

    if (this.noProvider) {
      this._state = "error";
      this.emitStatus();
      return;
    }

    const oldSandbox = this._sandbox;
    const provider = this.provider;
    this._epoch += 1;
    this._sandbox = null;
    // Silent transition — doProvision's own setState('provisioning') emits
    // the single status event for the new epoch.
    this._state = "provisioning";

    if (oldSandbox && provider) {
      // Prefer the optional `release` seam when the provider implements it
      // (spec decision 5): for a provider whose `destroy` cascades to
      // persistent storage, an unconditional `destroy` here would wipe the
      // workspace on every liveness-triggered re-provision. Providers that
      // don't implement `release` (docker/local/virtual) fall back to
      // `destroy` — byte-identical to prior behavior.
      void (provider.release ? provider.release(oldSandbox.id) : provider.destroy(oldSandbox.id)).catch(() => {});
    }

    this.kickProvision();
  }

  /**
   * The image the live sandbox has applied, per the most recent cached
   * observation. `null` when nothing has been observed yet (never provisioned,
   * or `forSandbox`). For tests and metrics — does not trigger an observation.
   */
  observedImage(): string | null {
    return this.observation?.applied.image ?? null;
  }

  /**
   * Converge the live sandbox toward the desired spec (spec decisions 3-7).
   * The caller gates idleness — this only runs the observe/diff/apply cycle.
   *
   * Single-flight: concurrent calls share one run (`specProvider` is invoked
   * exactly once per run). No-op unless the attachment is `ready` with a live
   * handle and a `specProvider` is set — a `provisioning`/`suspended`/`error`
   * attachment is left to the existing provision paths. Never throws: any
   * failure is logged and the state machinery (reportFailure/backoff) governs.
   *
   * Cases:
   *  - image drift → REPLACE: bump epoch, drop + release the old sandbox, and
   *    cold-provision the desired image (its create boots the persisted
   *    `createOpts.image`). Guarded by an exponential backoff memo so a spec
   *    that keeps failing to replace is retried with growing spacing.
   *  - step drift → apply the drifted steps in place (same epoch) and refresh
   *    the observation cache.
   *  - no drift → nothing beyond the observation read (and none of that when
   *    the cached observation is still fresh).
   */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    // Gate: only a live, ready, spec-driven attachment reconciles. A
    // `provisioning` attachment (including a fresh cold boot) is skipped —
    // reconcile must never race an in-flight provision (spec decision 5).
    if (this._state !== "ready" || !this._sandbox || !this.specProvider) {
      return Promise.resolve();
    }
    const run = this.doReconcile().finally(() => {
      this.reconciling = null;
    });
    this.reconciling = run;
    return run;
  }

  private async doReconcile(): Promise<void> {
    try {
      const sandbox = this._sandbox;
      const specProvider = this.specProvider;
      if (!sandbox || !specProvider || this._state !== "ready") return;
      const epoch = this._epoch;

      const desired = await specProvider();
      if (this.destroyed || this._state !== "ready" || this._epoch !== epoch) return;

      const observed = await this.observe(sandbox, epoch);
      if (this.destroyed || this._state !== "ready" || this._epoch !== epoch) return;

      // ── Image drift → replace ──────────────────────────────────────
      // Decision 8: only an isolated backend may pod-replace on image drift. A
      // non-isolated backend (docker/local/virtual — shared host, no per-pod
      // image) must NEVER tear down and re-provision, so it skips this branch
      // and falls through to step-drift-only convergence. Today this is inert
      // because desired.image is undefined for those backends; the guard makes
      // the invariant explicit and holds even if a desired.image ever leaks in.
      const isolated = this.provider?.capabilities().isolated === true;
      if (isolated && desired.image !== undefined && desired.image !== observed.image) {
        // Backoff: skip the replace when the SAME desired spec already failed
        // to replace within its exponential window (spec decision 6). A
        // repeatedly-failing image must not re-provision on every idle sweep.
        const failure = this.convergeFailure;
        if (failure && failure.specHash === desired.specHash) {
          const backoff = Math.min(REPLACE_BACKOFF_CAP_MS, 2 ** failure.attempts * 60_000);
          if (Date.now() - failure.failedAt < backoff) return;
        }

        const oldSandbox = this._sandbox;
        const provider = this.provider;
        // Persist the desired image BEFORE kicking the provision so its create
        // boots it (observed-image source of truth, spec decision 9).
        this.createOpts = { ...this.createOpts, image: desired.image };
        // Re-provision semantics: bump the epoch and drop the handle before
        // releasing the old sandbox (mirrors reportFailure).
        this._epoch += 1;
        this._sandbox = null;
        this.observation = null;
        this._state = "provisioning";
        if (oldSandbox && provider) {
          void (provider.release
            ? provider.release(oldSandbox.id)
            : provider.destroy(oldSandbox.id)
          ).catch(() => {});
        }
        this.kickProvision();
        // Await the re-provision so the backoff memo reflects the real outcome.
        // Waiters parked on ensureReady resolve independently — this await only
        // governs the memo, never a caller's readiness.
        if (this.inFlight) await this.inFlight.catch(() => {});
        if (this.destroyed) return;
        // Converged = the sandbox is ready AND the freshly-booted image matches
        // the desired image. A re-provision that ends in `error`, or one that
        // "succeeds" onto a non-converging image (a tag that resolves to the
        // old image, a provider that keeps the old container), both count as a
        // failed replace — record the memo so a matching-spec reconcile inside
        // the backoff window skips the replace instead of re-provisioning on
        // every idle sweep (spec decision 6).
        // Read through the getter so TS does not narrow `_state` to the literal
        // assigned before the await — the awaited provision mutated it.
        const converged = this.state === "ready" && this.observedImage() === desired.image;
        if (converged) {
          this.convergeFailure = null;
        } else {
          const attempts =
            (this.convergeFailure?.specHash === desired.specHash
              ? this.convergeFailure.attempts
              : 0) + 1;
          this.convergeFailure = { specHash: desired.specHash, failedAt: Date.now(), attempts };
        }
        return;
      }

      // ── Step drift → apply in place ────────────────────────────────
      const pending = diffSteps(desired.steps, observed);
      if (pending.length === 0) return; // no drift — fast path

      // observed.image is always the epoch's real boot image after observe()
      // resolves it (file image non-empty > createOpts.image > ""). The
      // fallback here is belt-and-suspenders: it prevents writing an empty
      // image string into the applied file if observe() somehow produced one.
      const image = observed.image || this.createOpts.image || "";
      const landed = await applyPlan(sandbox, desired, image, observed);
      if (this.destroyed || this._state !== "ready" || this._epoch !== epoch) return;
      // Refresh the observation with what the in-place apply ACTUALLY landed —
      // a step that failed non-critically is absent from `landed.steps`, so it
      // is not cache-"applied" and gets re-run on the next reconcile within the
      // TTL (spec decision 10).
      this.observation = this.observationFromApplied(landed, epoch);
    } catch (err) {
      // reconcile never throws — the existing failure paths own degradation.
      console.error("SandboxAttachment.reconcile failed", err);
    }
  }

  /**
   * Return the current applied state, from the in-memory cache when it is fresh
   * (same epoch, within OBSERVE_TTL_MS) or by reading the applied-state file and
   * refreshing the cache (spec decision 4 throttle). A read that returns null
   * (missing/corrupt file) is treated as empty applied state.
   *
   * Image precedence when the applied file is absent or carries an empty image:
   *   file image (non-empty) > createOpts.image > ""
   *
   * `createOpts.image` is the epoch's boot image (spec decision 9 — the replace
   * and boot paths persist the reconciled image before provisioning). Trusting it
   * here avoids writing `"image":""` into the applied file after a delete-file +
   * reconcile cycle, which would otherwise force a spurious full pod replacement
   * on the next boot for sessions whose desired image IS set (prebuild sessions).
   */
  /**
   * Build a fresh observation cache entry from the state `applyPlan` returned
   * (spec decision 10). Both the cold-provision and step-drift reconcile paths
   * use this so the cache always reflects what was ACTUALLY written to the
   * applied file — including the exclusion of any step that failed
   * non-critically — never the full desired step list. Stamps `at` to now.
   */
  private observationFromApplied(applied: AppliedState, epoch: number): ObservationCache {
    return { applied, at: Date.now(), epoch };
  }

  private async observe(sandbox: Sandbox, epoch: number): Promise<AppliedState> {
    const cache = this.observation;
    if (cache && cache.epoch === epoch && Date.now() - cache.at < OBSERVE_TTL_MS) {
      return cache.applied;
    }
    const read = await readAppliedState(sandbox);
    // Use the file's image when non-empty (it may know better than createOpts
    // after an api restart, which rebuilds createOpts from the host default).
    // Fall back to createOpts.image when the file is absent or has an empty
    // image string — the epoch was booted with that image (spec decision 9).
    const resolvedImage = (read?.image || undefined) ?? this.createOpts.image ?? "";
    const applied: AppliedState = read
      ? { ...read, image: resolvedImage }
      : { image: resolvedImage, specHash: "", steps: {} };
    this.observation = { applied, at: Date.now(), epoch };
    return applied;
  }

  /**
   * Destroys the raw sandbox (if present) and marks the attachment
   * `released`, a terminal state. Cancels any in-flight provisioning: once
   * it resolves, the newly-created sandbox is discarded (best-effort
   * destroyed) rather than adopted.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    const sandbox = this._sandbox;
    this._sandbox = null;
    this._state = "released";
    this.emitStatus();

    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const w of waiters) {
      w.reject(new SandboxUnavailableError(new Error("sandbox attachment destroyed")));
    }

    if (sandbox?.destroy) {
      await sandbox.destroy().catch(() => {});
    } else if (sandbox && this.provider) {
      await this.provider.destroy(sandbox.id).catch(() => {});
    }
  }

  // ── internals ──────────────────────────────────────────────────────

  private abortError(signal: AbortSignal | undefined): Error {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    return new Error("aborted");
  }

  private kickProvision(): void {
    if (this.destroyed || this.noProvider) return;
    if (this._state === "ready") return;
    if (this.inFlight) return;
    // A `suspended` attachment already holds a live handle and epoch — wake it
    // via `resume` rather than a fresh `create` (no epoch mint, id stable). All
    // other non-ready states go through the cold-provision path.
    if (this._state === "suspended") {
      this.inFlight = this.doResume();
      return;
    }
    if (this._epoch === 0) this._epoch = 1;
    this.inFlight = this.doProvision();
  }

  private async doResume(): Promise<void> {
    // Wake folding (spec decision 3, wake-when-stale). Before waking the
    // suspended sandbox, a cheap pre-check compares the desired image to what
    // the cached observation says the sandbox has applied. On a mismatch, a
    // plain resume would wake the STALE image, so instead we discard the
    // suspended handle and cold-provision the desired image.
    //
    // Epoch choice: a clean suspend/resume deliberately does NOT bump the epoch
    // (ops in flight before hibernation are not superseded). A stale wake that
    // reroutes through a fresh provision IS a re-provision, so we bump the epoch
    // exactly like reportFailure — otherwise the fresh boot would re-emit the
    // suspended epoch's `provisioning`/`ready` and collide on the durable
    // eventKey. The old handle is released (or destroyed) best-effort.
    //
    // Cache-empty guard: with no observation we cannot compare (observation
    // needs a live sandbox), so we allow the resume — a subsequent `reconcile`
    // on the woken sandbox will read the applied file and replace if stale.
    if (this.specProvider && this.observation && this._state === "suspended") {
      let staleWake = false;
      try {
        const desired = await this.specProvider();
        staleWake =
          desired.image !== undefined && desired.image !== this.observation.applied.image;
        if (staleWake && desired.image !== this.observation.applied.image) {
          // Persist the desired image so the fresh provision boots it.
          this.createOpts = { ...this.createOpts, image: desired.image };
        }
      } catch (err) {
        // A failed pre-check must not strand the wake — fall through to the
        // normal resume path, which has its own error handling.
        console.error("SandboxAttachment: wake-folding pre-check failed", err);
        staleWake = false;
      }
      if (this.destroyed) {
        this.inFlight = null;
        return;
      }
      if (staleWake) {
        const oldSandbox = this._sandbox;
        const provider = this.provider;
        // Bump the epoch (re-provision semantics) and drop the stale handle
        // BEFORE releasing it — a concurrent op sees the new epoch immediately.
        this._epoch += 1;
        this._sandbox = null;
        this.observation = null;
        this._state = "provisioning";
        if (oldSandbox && provider) {
          void (provider.release
            ? provider.release(oldSandbox.id)
            : provider.destroy(oldSandbox.id)
          ).catch(() => {});
        }
        // Hand off to a fresh cold provision for the new epoch. Clear inFlight
        // first so kickProvision's guard does not no-op on this doResume.
        this.inFlight = null;
        this.kickProvision();
        return;
      }
    }
    // Capture the epoch this wake belongs to. A concurrent reportFailure() can
    // bump the epoch (and null the handle) WHILE provider.resume is in flight —
    // it deliberately matches the still-current epoch, degrades, and re-kicks a
    // provision that no-ops because this doResume holds `inFlight`. If we then
    // blindly marked ready, `_sandbox` would be null (reportFailure dropped it)
    // → a permanent `ready`+null deadlock: flushWaiters bails on the null guard
    // and every future ensureReady misses the fast-path while kickProvision
    // returns early on `ready`. So on completion we detect the supersession and
    // hand off to a fresh provision for the new epoch instead.
    const startEpoch = this._epoch;
    const sandbox = this._sandbox;
    const provider = this.provider;
    // Silent-ish transition: emit a single `provisioning` status for the wake,
    // mirroring doProvision. The epoch is deliberately left unchanged.
    this._state = "provisioning";
    this.emitStatus();
    let superseded = false;
    try {
      if (!provider) throw new Error("no provider");
      if (!provider.resume) throw new Error("provider does not support hibernation");
      if (!sandbox) throw new Error("suspended attachment has no sandbox handle");
      await provider.resume(sandbox.id);
      if (this.destroyed) return;
      // Superseded by a concurrent reportFailure (epoch bumped and/or the handle
      // dropped): discard this wake WITHOUT marking ready — the waiters stay
      // parked and are settled exactly once by the re-provision kicked below.
      if (this._epoch !== startEpoch || this._sandbox === null) {
        superseded = true;
        return;
      }
      // Push credential files after resume. provider.create() owns the cold
      // path (k8s upserts the Secret inside create()). The resume path exists
      // because a pre-feature pod suspended before credsMount was deployed has
      // no Secret; updateCreds is upsert-shaped, so this materializes the
      // missing Secret and is idempotent for pods that already have one.
      // Best-effort: a push failure must never strand a wake — the 24h env-var
      // fallback covers the sandbox. Docker resume throws "not found" after an
      // API restart (in-memory map is gone), so this branch is unreachable for
      // docker post-restart.
      await this.pushCredsBestEffort(sandbox, "resume");
      // The raw handle is reused as-is — resume wakes the same sandbox.
      this._state = "ready";
      this.emitStatus();
      this.flushWaiters();
    } catch (err) {
      if (this.destroyed) return;
      this._state = "error";
      this.emitStatus();
      // Same fast-fail rule as doProvision: a terminal SandboxStartupError
      // rejects waiters now; any other failure lets each waiter's own
      // ensureReady timeout govern (a slow wake is not degradation).
      if (err instanceof SandboxStartupError) {
        const waiters = [...this.waiters];
        this.waiters.clear();
        for (const w of waiters) w.reject(err);
      }
    } finally {
      this.inFlight = null;
      // reportFailure already set `provisioning` and released the old handle;
      // its kickProvision no-op'd on our `inFlight`. Now that it's clear, drive
      // the re-provision for the new epoch — this is the degradation's intended
      // re-provision, and its flushWaiters resolves the parked waiters.
      if (superseded) this.kickProvision();
    }
  }

  private async doProvision(): Promise<void> {
    // Traced (distributed tracing): the whole cold boot — provider.create +
    // the specProvider steps — as one `sandbox.provision` span, so
    // cold-start latency is directly attributable in traces (a concurrent
    // sandbox.exec span's wait is explained by this one).
    return withSpan(
      "sandbox.provision",
      {
        "valet.sandbox.epoch": this._epoch,
        ...(this.createOpts.image !== undefined ? { "valet.sandbox.image": this.createOpts.image } : {}),
        ...(this.createOpts.profile !== undefined
          ? { "valet.sandbox.profile": this.createOpts.profile }
          : {}),
      },
      async (span) => {
        const startedAt = Date.now();
        await this.doProvisionInner();
        // doProvisionInner never throws (failures land in the error state) —
        // report ok by whether a live handle came out of the provision.
        const ok = this._state === "ready";
        recordSandboxProvision(Date.now() - startedAt, ok);
        span.setAttribute("valet.sandbox.result_state", this._state);
        if (this._sandbox) span.setAttribute("valet.sandbox.id", this._sandbox.id);
        if (!ok) markSpanError(span, `provision ended in state ${this._state}`);
      },
    );
  }

  private async doProvisionInner(): Promise<void> {
    this._state = "provisioning";
    this.emitStatus();
    const provider = this.provider;
    try {
      if (!provider) throw new Error("no provider");
      // Post-provision prep (specProvider seam). Runs once per (sandbox, epoch)
      // AFTER the sandbox reports ready and BEFORE we mark `ready`/flush
      // waiters — no waiter may ever observe an unprepped sandbox (`_sandbox`
      // is still null and `_state` still `provisioning` throughout, so
      // `current()`/the ensureReady fast-path both miss). Absent specProvider:
      // this block is skipped and the path below is byte-identical to the
      // pre-seam behavior. Only the cold `doProvision` runs prep — a
      // hibernation wake (`doResume`, same epoch) deliberately does not.
      //
      // Task 5: the desired spec selects the boot image. Fetch the spec BEFORE
      // create so the container boots the desired image; a freshly-created
      // container has no applied state, so `applyPlan` runs with `applied:
      // null` (a full apply — no observation read needed). The desired image is
      // ALSO persisted into `createOpts` so a later failure re-provision boots
      // the same reconciled image (spec decision 9).
      let desired: DesiredSandboxSpec | undefined;
      if (this.specProvider) {
        desired = await this.specProvider();
      }
      const bootImage = desired?.image ?? this.createOpts.image;
      if (desired?.image !== undefined && desired.image !== this.createOpts.image) {
        this.createOpts = { ...this.createOpts, image: desired.image };
      }
      const sandbox = await provider.create({ ...this.createOpts, image: bootImage });
      if (this.destroyed) {
        await provider.destroy(sandbox.id).catch(() => {});
        return;
      }
      if (desired) {
        try {
          const appliedImage = bootImage ?? "";
          const landed = await applyPlan(sandbox, desired, appliedImage, null);
          // Cache what the fresh container ACTUALLY has applied (spec decision
          // 4): the state applyPlan last wrote, which excludes any step that
          // failed non-critically. reconcile trusts this within OBSERVE_TTL_MS
          // instead of re-reading the file, and re-runs a failed step next pass
          // (spec decision 10) instead of treating it as applied.
          this.observation = this.observationFromApplied(landed, this._epoch);
        } catch (prepErr) {
          // Terminal for this provision. Best-effort destroy the unprepped
          // sandbox unconditionally so the handle never leaks — even if a
          // concurrent destroy() raced (it saw `_sandbox` still null and so
          // could not tear this one down). Then classify as a startup-shaped
          // failure via the outer catch.
          await provider.destroy(sandbox.id).catch(() => {});
          if (this.destroyed) return;
          throw new SandboxPreparationError(prepErr);
        }
      }
      // A destroy() that raced an in-flight prep wins — discard the (now
      // prepped) sandbox rather than adopting it.
      if (this.destroyed) {
        await provider.destroy(sandbox.id).catch(() => {});
        return;
      }
      this._sandbox = sandbox;
      this._state = "ready";
      this.emitStatus();
      this.flushWaiters();
    } catch (err) {
      if (this.destroyed) return;
      this._state = "error";
      this.emitStatus();
      // Waiters are not force-failed here — a slow/failed provision still
      // lets each caller's own ensureReady timeout govern its wait, per the
      // spec's "timeout is not degradation" rule (test case 4). The
      // exceptions are terminal failures that will not resolve on their own:
      // a `SandboxStartupError` (bad image, crash-loop, unschedulable pod) or
      // a `SandboxPreparationError` (the host prep hook rejected) — waiters
      // get the real cause now instead of a generic timeout later.
      if (err instanceof SandboxStartupError || err instanceof SandboxPreparationError) {
        const waiters = [...this.waiters];
        this.waiters.clear();
        for (const w of waiters) w.reject(err);
      }
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Push credential files into `sandbox` best-effort. Guards on
   * `provider.updateCreds`, `capabilities().credsMount`, and non-empty
   * `credsFiles`. A failure is logged and swallowed — the 24h env-var
   * fallback still covers the sandbox. `context` names the call site for the
   * log message.
   */
  private async pushCredsBestEffort(sandbox: Sandbox, context: string): Promise<void> {
    const provider = this.provider;
    if (
      !provider?.updateCreds ||
      !provider.capabilities().credsMount ||
      !this.createOpts.credsFiles ||
      Object.keys(this.createOpts.credsFiles).length === 0
    ) {
      return;
    }
    await provider.updateCreds(sandbox.id, this.createOpts.credsFiles).catch((err) => {
      console.error(`SandboxAttachment: updateCreds after ${context} failed (non-fatal)`, err);
    });
  }

  /** Resolves every pending `ensureReady` waiter with the now-ready sandbox. */
  private flushWaiters(): void {
    if (!this._sandbox) return;
    const sandbox = this._sandbox;
    const epoch = this._epoch;
    const list = [...this.waiters];
    this.waiters.clear();
    for (const w of list) w.resolve({ sandbox, epoch });
  }

  private emitStatus(): void {
    const status: AttachmentStatus = {
      state: this._state,
      sandboxId: this._sandbox?.id,
      epoch: this._epoch,
      estimateMs: this.estimateMs,
      wake: this._wakeCount,
    };
    for (const cb of this.listeners) {
      try {
        cb(status);
      } catch (err) {
        console.error("SandboxAttachment: onStatus listener threw", err);
      }
    }
  }
}
