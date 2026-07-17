import type { Sandbox, SandboxCreateOpts, SandboxProvider } from "../types.js";
import {
  SandboxPreparationError,
  SandboxStartupError,
  SandboxUnavailableError,
  WorkspaceProvisioningError,
} from "../errors.js";

/**
 * Optional host post-provision prep hook. Awaited once per (sandbox, epoch) in
 * `doProvision` after readiness and before any waiter resolves; see
 * `CreateSessionOptions.prepareSandbox`.
 */
export type PrepareSandbox = (sandbox: Sandbox, epoch: number) => Promise<void>;

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
  private readonly createOpts: SandboxCreateOpts;
  private readonly prepare: PrepareSandbox | undefined;
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

  constructor(provider: SandboxProvider, createOpts: SandboxCreateOpts, prepare?: PrepareSandbox) {
    this.provider = provider;
    this.createOpts = createOpts;
    this.prepare = prepare;
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
    this._state = "provisioning";
    this.emitStatus();
    const provider = this.provider;
    try {
      if (!provider) throw new Error("no provider");
      const sandbox = await provider.create(this.createOpts);
      if (this.destroyed) {
        await provider.destroy(sandbox.id).catch(() => {});
        return;
      }
      // Post-provision prep (host `prepareSandbox` seam). Runs once per
      // (sandbox, epoch) AFTER the sandbox reports ready and BEFORE we mark
      // `ready`/flush waiters — no waiter may ever observe an unprepped
      // sandbox (`_sandbox` is still null and `_state` still `provisioning`
      // throughout, so `current()`/the ensureReady fast-path both miss).
      // Absent hook: this block is skipped and the path below is byte-identical
      // to the pre-seam behavior. Only the cold `doProvision` runs prep — a
      // hibernation wake (`doResume`, same epoch) deliberately does not.
      if (this.prepare) {
        try {
          await this.prepare(sandbox, this._epoch);
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
