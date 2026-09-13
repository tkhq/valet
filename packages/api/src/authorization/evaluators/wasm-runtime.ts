import { Worker } from "node:worker_threads";
import { LocalEvaluatorError, type LocalEvaluatorErrorCode } from "./errors.js";

export const MAX_WALL_TIME_MS = 100;
export const MAX_ENGINE_MEMORY_BYTES = 64 * 1024 * 1024;

type EngineCommand = Record<string, unknown>;

interface EngineSuccess<T> {
  readonly status: "ok";
  readonly value: T;
}

interface EngineFailure {
  readonly status: "error";
  readonly code: string;
  readonly message: string;
}

type EngineResponse<T> = EngineSuccess<T> | EngineFailure;

interface PendingRequest {
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class WasmPolicyRuntime {
  private worker: Worker;
  private generation = 0;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly workerUrl = new URL("./policy-worker.cjs", import.meta.url)) {
    this.worker = this.spawn();
  }

  run<T>(command: EngineCommand): Promise<T> {
    if (this.closed) {
      return Promise.reject(new LocalEvaluatorError("worker_failure", "The policy runtime is closed."));
    }
    const id = ++this.nextId;
    const generation = this.generation;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (generation !== this.generation || !this.pending.has(id)) return;
        this.replaceWorker(new LocalEvaluatorError("timeout", `Policy evaluation exceeded ${MAX_WALL_TIME_MS} ms.`));
      }, MAX_WALL_TIME_MS);
      this.pending.set(id, {
        timer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.worker.postMessage({ id, command });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failPending(new LocalEvaluatorError("worker_failure", "The policy runtime was closed."));
    await this.worker.terminate();
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl, {
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    worker.on("message", (message: { id?: number; response?: EngineResponse<unknown> }) => {
      if (message.id === undefined || message.response === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.response.status === "ok") {
        pending.resolve(message.response.value);
      } else {
        pending.reject(
          new LocalEvaluatorError(normalizeCode(message.response.code), message.response.message),
        );
      }
    });
    worker.on("error", (error) => {
      if (this.closed || worker !== this.worker) return;
      const code = /memory|allocation|out of bounds/i.test(error.message) ? "memory_limit" : "worker_failure";
      this.replaceWorker(new LocalEvaluatorError(code, error.message, { cause: error }));
    });
    worker.on("exit", (code) => {
      if (!this.closed && code !== 0 && worker === this.worker) {
        this.replaceWorker(new LocalEvaluatorError("worker_failure", `Policy worker exited with code ${code}.`));
      }
    });
    return worker;
  }

  private replaceWorker(error: LocalEvaluatorError): void {
    const oldWorker = this.worker;
    this.generation += 1;
    this.failPending(error);
    this.worker = this.spawn();
    void oldWorker.terminate();
  }

  private failPending(error: LocalEvaluatorError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function normalizeCode(code: string): LocalEvaluatorErrorCode {
  switch (code) {
    case "incompatible_bundle":
    case "invalid_bundle_or_evaluation":
    case "limit":
    case "malformed_output":
    case "malformed_request":
    case "memory_limit":
    case "worker_failure":
      return code;
    default:
      return "worker_failure";
  }
}
