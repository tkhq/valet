import type { Sandbox, SandboxCreateOpts, SandboxProvider } from "../types.js";
import { SandboxUnavailableError, WorkspaceProvisioningError } from "../errors.js";

/**
 * Attachment lifecycle states (spec decision 2). `detached` = never
 * provisioned; `provisioning` = a `provider.create` is in flight;
 * `ready` = a live raw `Sandbox` is attached; `error` = provisioning
 * failed or (for `forSandbox` attachments) a reported failure with no
 * provider to recover with; `released` = `destroy()` was called — terminal.
 */
export type AttachmentState = "detached" | "provisioning" | "ready" | "error" | "released";

export interface AttachmentStatus {
  state: AttachmentState;
  sandboxId?: string;
  epoch: number;
  estimateMs?: number;
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
  private readonly estimateMs: number | undefined;
  private noProvider: boolean;

  private _state: AttachmentState = "detached";
  private _epoch = 0;
  private _sandbox: Sandbox | null = null;
  private destroyed = false;
  private inFlight: Promise<void> | null = null;
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<StatusListener>();

  constructor(provider: SandboxProvider, createOpts: SandboxCreateOpts) {
    this.provider = provider;
    this.createOpts = createOpts;
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
      (timer as unknown as { unref?: () => void }).unref?.();

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
   * destroys the old sandbox, and kicks a background re-provision. Stale
   * reports (an old epoch that is no longer current) are ignored — no
   * state change, no extra `create`.
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
      void provider.destroy(oldSandbox.id).catch(() => {});
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
    if (this._epoch === 0) this._epoch = 1;
    this.inFlight = this.doProvision();
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
      this._sandbox = sandbox;
      this._state = "ready";
      this.emitStatus();
      this.flushWaiters();
    } catch {
      if (this.destroyed) return;
      this._state = "error";
      this.emitStatus();
      // Waiters are not force-failed here — a slow/failed provision still
      // lets each caller's own ensureReady timeout govern its wait, per the
      // spec's "timeout is not degradation" rule (test case 4).
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
    };
    for (const cb of this.listeners) cb(status);
  }
}
