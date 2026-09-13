import { Worker } from "node:worker_threads";
import type { CanonicalSourceBundle, ValidatedBundleIdentity } from "../bundles/types.js";
import { policyWorkerUrl } from "../../assets/base.js";
import { LocalEvaluatorError, type LocalEvaluatorErrorCode } from "./errors.js";

export const MAX_WALL_TIME_MS = 100;
export const MAX_WASM_LINEAR_MEMORY_BYTES = 64 * 1024 * 1024;
export const MAX_WORKER_HEAP_MIB = 64;
const MAX_READY_TIME_MS = 5_000;
const MAX_QUEUE_TIME_MS = 5_000;
const MAX_START_TIME_MS = 1_000;
const MAX_CONTROL_TIME_MS = 10_000;

export interface RuntimeIdentity {
  readonly engineDigest: string;
  readonly engineName: "valet-policy-engine";
  readonly engineVersion: "0.1.0";
  readonly contractVersion: 1;
  readonly capabilityProfileVersion: 1;
  readonly regoVersion: "v1";
  readonly interpreterName: "regorus";
  readonly interpreterVersion: "0.12.0";
  readonly interpreterRevision: "aee1a9b12b1ec1e0599a53acd665b31d3bb5ea2e";
  readonly target: "wasm32-unknown-unknown-worker";
  readonly maxWallTimeMs: 100;
  readonly maxEngineMemoryBytes: 67108864;
}

type EngineCommand = Record<string, unknown> & { readonly operation: string };
type WorkerUrl = URL | ((generation: number) => URL);
interface EngineResponse<T> {
  readonly status: "ok" | "error";
  readonly value?: T;
  readonly code?: string;
  readonly message?: string;
}
interface WorkerMessage<T = unknown> {
  readonly type: "ready" | "started" | "result";
  readonly id?: number;
  readonly identity?: RuntimeIdentity;
  readonly response?: EngineResponse<T>;
  readonly fatal?: boolean;
}
interface PendingRequest {
  readonly id: number;
  readonly state: WorkerState;
  readonly timeoutMs: number;
  started: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}
interface QueueEntry {
  started: boolean;
  cancelled: boolean;
  settled: boolean;
  timer?: NodeJS.Timeout;
  reject: (error: Error) => void;
}
interface WorkerState {
  readonly worker: Worker;
  readonly generation: number;
  readonly ready: Promise<RuntimeIdentity>;
  resolveReady: (identity: RuntimeIdentity) => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  readySucceeded: boolean;
  poison?: Promise<void>;
}

export class WasmPolicyRuntime {
  private state: WorkerState;
  private starting?: WorkerState;
  private nextId = 0;
  private closed = false;
  private closing?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private readonly queued = new Set<QueueEntry>();
  private pending?: PendingRequest;
  private readonly loaded = new Map<string, ValidatedBundleIdentity>();

  constructor(private readonly workerUrl: WorkerUrl = policyWorkerUrl()) {
    this.state = this.spawn(0);
  }

  get generation(): number {
    return this.state.generation;
  }

  async identity(): Promise<RuntimeIdentity> {
    this.assertOpen();
    const identity = await this.waitUntilReady(this.state);
    this.assertOpen();
    return identity;
  }

  async loadBundle(
    expectedSourceBundleDigest: string,
    bundle: CanonicalSourceBundle,
  ): Promise<ValidatedBundleIdentity> {
    const cached = this.loaded.get(expectedSourceBundleDigest);
    if (cached !== undefined) return cached;
    const identity = await this.run<ValidatedBundleIdentity>({
      operation: "load_bundle",
      expected_source_bundle_digest: expectedSourceBundleDigest,
      bundle,
    });
    if (identity.sourceBundleDigest !== expectedSourceBundleDigest) {
      throw new LocalEvaluatorError("bundle_digest_mismatch", "The loaded policy bundle digest changed.");
    }
    this.loaded.set(expectedSourceBundleDigest, identity);
    return identity;
  }

  run<T>(command: EngineCommand): Promise<T> {
    if (this.closed) return Promise.reject(closedError());

    const predecessor = this.queue;
    let resolveVisible!: (value: T) => void;
    let rejectVisible!: (error: Error) => void;
    const visible = new Promise<T>((resolve, reject) => {
      resolveVisible = resolve;
      rejectVisible = reject;
    });
    const entry: QueueEntry = {
      started: false,
      cancelled: false,
      settled: false,
      reject: (error) => settleReject(entry, error, rejectVisible),
    };
    this.queued.add(entry);
    entry.timer = setTimeout(() => {
      if (entry.started) return;
      entry.cancelled = true;
      entry.reject(new LocalEvaluatorError("worker_queue", `Policy request waited more than ${MAX_QUEUE_TIME_MS} ms.`));
    }, MAX_QUEUE_TIME_MS);

    const task = predecessor.then(async () => {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (entry.cancelled) {
        this.queued.delete(entry);
        return;
      }
      entry.started = true;
      if (this.closed) {
        entry.reject(closedError());
        this.queued.delete(entry);
        return;
      }
      try {
        settleResolve(entry, await this.execute<T>(command), resolveVisible);
      } catch (error) {
        entry.reject(asError(error));
      } finally {
        this.queued.delete(entry);
      }
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return visible;
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    const error = closedError();
    for (const entry of this.queued) {
      entry.cancelled = true;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending?.reject(error);
    this.clearPending();
    const states = [...new Set([this.state, this.starting].filter((state): state is WorkerState => state !== undefined))];
    for (const state of states) this.rejectReadiness(state, error);
    this.closing = (async () => {
      await Promise.all(states.map((state) => state.worker.terminate().catch(() => undefined)));
      await this.queue;
      this.queued.clear();
    })();
    return this.closing;
  }

  private async execute<T>(command: EngineCommand): Promise<T> {
    if (this.pending !== undefined) {
      throw new LocalEvaluatorError("worker_failure", "The policy worker already has a pending command.");
    }
    this.assertOpen();
    const state = this.state;
    await this.waitUntilReady(state);
    this.assertOpen();
    if (state !== this.state) return this.execute(command);
    if (this.pending !== undefined) {
      throw new LocalEvaluatorError("worker_failure", "The policy worker already has a pending command.");
    }
    const id = ++this.nextId;
    const timeoutMs = command.operation === "evaluate" ? MAX_WALL_TIME_MS : MAX_CONTROL_TIME_MS;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        state,
        timeoutMs,
        started: false,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      pending.timer = setTimeout(() => {
        void this.rejectFatal(
          pending,
          new LocalEvaluatorError("command_start", `Policy worker did not start within ${MAX_START_TIME_MS} ms.`),
        );
      }, MAX_START_TIME_MS);
      this.pending = pending;
      if (this.closed) {
        this.clearPending();
        reject(closedError());
        return;
      }
      try {
        state.worker.postMessage({ id, command: wireCommand(command) });
      } catch (error) {
        void this.rejectFatal(pending, new LocalEvaluatorError("worker_failure", asError(error).message, { cause: error }));
      }
    });
  }

  private spawn(generation: number): WorkerState {
    let resolveReady!: (identity: RuntimeIdentity) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<RuntimeIdentity>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const url = typeof this.workerUrl === "function" ? this.workerUrl(generation) : this.workerUrl;
    const worker = new Worker(url, {
      resourceLimits: { maxOldGenerationSizeMb: MAX_WORKER_HEAP_MIB },
    });
    const state: WorkerState = {
      worker,
      generation,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      readySucceeded: false,
    };
    worker.on("message", (message: WorkerMessage) => this.onMessage(state, message));
    worker.on("error", (error) => this.onWorkerFailure(state, error));
    worker.on("exit", (code) => {
      if (!this.closed && code !== 0 && (state === this.state || state === this.starting)) {
        this.onWorkerFailure(state, new Error(`Policy worker exited with code ${code}.`));
      }
    });
    return state;
  }

  private onMessage(state: WorkerState, message: WorkerMessage): void {
    if (message.type === "ready") {
      if (state.readySettled) return;
      if (message.identity === undefined) {
        this.rejectReadiness(state, new LocalEvaluatorError("stale_artifact", "The policy worker omitted its identity."));
        return;
      }
      try {
        validateIdentity(message.identity);
        state.readySettled = true;
        state.readySucceeded = true;
        state.resolveReady(message.identity);
      } catch (error) {
        this.rejectReadiness(state, asError(error));
      }
      return;
    }
    const pending = this.pending;
    if (pending === undefined || pending.state !== state || pending.id !== message.id) return;
    if (message.type === "started") {
      if (pending.started) return;
      pending.started = true;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        void this.rejectFatal(
          pending,
          new LocalEvaluatorError(
            pending.timeoutMs === MAX_WALL_TIME_MS ? "timeout" : "command_timeout",
            `Policy ${pending.timeoutMs === MAX_WALL_TIME_MS ? "evaluation" : "control command"} exceeded ${pending.timeoutMs} ms.`,
          ),
        );
      }, pending.timeoutMs);
      return;
    }
    if (message.response === undefined) return;
    if (!pending.started) {
      void this.rejectFatal(
        pending,
        new LocalEvaluatorError("command_start", "The policy worker returned a result before command start."),
      );
      return;
    }
    if (message.fatal === true) {
      void this.rejectFatal(
        pending,
        new LocalEvaluatorError(
          normalizeCode(message.response.code),
          message.response.message ?? "The policy engine trapped.",
        ),
      );
      return;
    }
    this.clearPending();
    if (message.response.status === "ok" && message.response.value !== undefined) {
      pending.resolve(message.response.value);
    } else {
      pending.reject(
        new LocalEvaluatorError(
          normalizeCode(message.response.code),
          message.response.message ?? "The policy engine rejected the command.",
        ),
      );
    }
  }

  private onWorkerFailure(state: WorkerState, error: Error): void {
    if (!state.readySucceeded) {
      if (!state.readySettled) {
        this.rejectReadiness(state, new LocalEvaluatorError("worker_readiness", error.message, { cause: error }));
      }
      return;
    }
    const pending = this.pending;
    if (pending?.state === state) {
      void this.rejectFatal(pending, new LocalEvaluatorError("engine_trap", error.message, { cause: error }));
    } else if (state === this.state && !this.closed) {
      void this.replace(state).catch(() => undefined);
    }
  }

  private async rejectFatal(pending: PendingRequest, error: LocalEvaluatorError): Promise<void> {
    if (this.pending !== pending) return;
    this.clearPending();
    try {
      await this.replace(pending.state);
      pending.reject(error);
    } catch (replacementError) {
      pending.reject(asError(replacementError));
    }
  }

  private replace(state: WorkerState): Promise<void> {
    if (state.poison !== undefined) return state.poison;
    state.poison = (async () => {
      await state.worker.terminate();
      this.assertOpen();
      const replacement = this.spawn(state.generation + 1);
      this.starting = replacement;
      this.loaded.clear();
      try {
        await this.waitUntilReady(replacement);
        this.assertOpen();
        this.state = replacement;
      } catch (error) {
        await replacement.worker.terminate().catch(() => undefined);
        throw error;
      } finally {
        if (this.starting === replacement) this.starting = undefined;
      }
    })();
    return state.poison;
  }

  private rejectReadiness(state: WorkerState, error: Error): void {
    if (state.readySettled) return;
    state.readySettled = true;
    state.rejectReady(error);
    void state.worker.terminate();
  }

  private waitUntilReady(state: WorkerState): Promise<RuntimeIdentity> {
    if (this.closed) return Promise.reject(closedError());
    const error = new LocalEvaluatorError(
      "worker_readiness",
      `Policy worker was not ready within ${MAX_READY_TIME_MS} ms.`,
    );
    const ready = withTimeout(state.ready, MAX_READY_TIME_MS, error);
    ready.catch((reason: unknown) => {
      if (reason === error) this.rejectReadiness(state, error);
    });
    return ready;
  }

  private clearPending(): void {
    if (this.pending?.timer !== undefined) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw closedError();
  }
}

function settleResolve<T>(entry: QueueEntry, value: T, resolve: (value: T) => void): void {
  if (entry.settled) return;
  entry.settled = true;
  resolve(value);
}

function settleReject(entry: QueueEntry, error: Error, reject: (error: Error) => void): void {
  if (entry.settled) return;
  entry.settled = true;
  reject(error);
}

function closedError(): LocalEvaluatorError {
  return new LocalEvaluatorError("worker_failure", "The policy runtime is closed.");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function wireCommand(command: EngineCommand): EngineCommand {
  const wire = { ...command };
  for (const [source, target] of [
    ["sourceBundleDigest", "source_bundle_digest"],
    ["maxWorkUnits", "max_work_units"],
  ] as const) {
    if (source in wire) {
      wire[target] = wire[source];
      delete wire[source];
    }
  }
  return wire;
}

function validateIdentity(identity: RuntimeIdentity): void {
  const valid =
    identity.engineName === "valet-policy-engine" &&
    identity.engineVersion === "0.1.0" &&
    identity.contractVersion === 1 &&
    identity.capabilityProfileVersion === 1 &&
    identity.regoVersion === "v1" &&
    identity.interpreterName === "regorus" &&
    identity.interpreterVersion === "0.12.0" &&
    identity.interpreterRevision === "aee1a9b12b1ec1e0599a53acd665b31d3bb5ea2e" &&
    identity.target === "wasm32-unknown-unknown-worker" &&
    identity.maxWallTimeMs === MAX_WALL_TIME_MS &&
    identity.maxEngineMemoryBytes === MAX_WASM_LINEAR_MEMORY_BYTES &&
    /^[0-9a-f]{64}$/.test(identity.engineDigest);
  if (!valid) {
    throw new LocalEvaluatorError("stale_artifact", "The policy worker identity does not match the pinned engine.");
  }
}

function normalizeCode(code: string | undefined): LocalEvaluatorErrorCode {
  switch (code) {
    case "bundle_digest_mismatch":
    case "bundle_not_loaded":
    case "decision_contract":
    case "engine_trap":
    case "evaluation_budget":
    case "incompatible_bundle":
    case "invalid_bundle_or_evaluation":
    case "limit":
    case "malformed_request":
    case "memory_limit":
    case "malformed_output":
    case "policy":
    case "rejected_builtin":
      return code;
    default:
      return "worker_failure";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}
