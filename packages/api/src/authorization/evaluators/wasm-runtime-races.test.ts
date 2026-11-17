import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { WasmPolicyRuntime } from "./wasm-runtime.js";

const protocolWorker = new URL("./fixtures/protocol-worker.cjs", import.meta.url);
const delayedReadyWorker = new URL("./fixtures/delayed-ready-worker.cjs", import.meta.url);
const failedReadyWorker = new URL("./fixtures/failed-ready-worker.cjs", import.meta.url);
const missingWorker = new URL("./fixtures/missing-worker.cjs", import.meta.url);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function handled<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
}

describe("WASM policy runtime races", () => {
  it("keeps the running queue tail after a caller-visible queue timeout", async () => {
    const runtime = new WasmPolicyRuntime(protocolWorker);
    try {
      const order: string[] = [];
      const first = runtime.run<string>({ operation: "slow", value: "A" }).then((value) => {
        order.push(value);
        return value;
      });
      await delay(50);
      const second = runtime.run<string>({ operation: "immediate", value: "B" });
      await expect(second).rejects.toMatchObject({ code: "worker_queue" });

      const third = runtime.run<string>({ operation: "immediate", value: "C" }).then((value) => {
        order.push(value);
        return value;
      });
      await expect(Promise.race([first, delay(4_000).then(() => "hung")])).resolves.toBe("A");
      await expect(third).resolves.toBe("C");
      expect(order).toEqual(["A", "C"]);
    } finally {
      await runtime.close();
    }
  }, 12_000);

  it("preempts a started host stall with a stable margin and recovers", async () => {
    const runtime = new WasmPolicyRuntime(protocolWorker);
    try {
      await runtime.identity();
      const baselineStart = performance.now();
      await expect(runtime.run({ operation: "measure_stall" })).resolves.toBe("measure_stall");
      expect(performance.now() - baselineStart).toBeGreaterThanOrEqual(400);

      const generation = runtime.generation;
      const start = performance.now();
      await expect(runtime.run({ operation: "evaluate" })).rejects.toMatchObject({ code: "timeout" });
      expect(performance.now() - start).toBeLessThan(500);
      expect(runtime.generation).toBe(generation + 1);
      await expect(runtime.run({ operation: "immediate", value: "recovered" })).resolves.toBe("recovered");
    } finally {
      await runtime.close();
    }
  });

  it("settles running and queued calls when close interrupts a command", async () => {
    const runtime = new WasmPolicyRuntime(protocolWorker);
    await runtime.identity();
    const first = handled(runtime.run({ operation: "slow", value: "A" }));
    const second = handled(runtime.run({ operation: "immediate", value: "B" }));
    await delay(50);
    const start = performance.now();
    await runtime.close();
    expect(performance.now() - start).toBeLessThan(1_000);
    await expect(first).rejects.toMatchObject({ code: "worker_failure" });
    await expect(second).rejects.toMatchObject({ code: "worker_failure" });
    expect(runtime.generation).toBe(0);
    await runtime.close();
  });

  it("does not post or leak a worker when closed during startup", async () => {
    const runtime = new WasmPolicyRuntime(delayedReadyWorker);
    const command = handled(runtime.run({ operation: "immediate" }));
    const start = performance.now();
    await runtime.close();
    expect(performance.now() - start).toBeLessThan(1_000);
    await expect(command).rejects.toMatchObject({ code: "worker_failure" });
    expect(runtime.generation).toBe(0);
  });

  it("does not publish a replacement when closed during replacement startup", async () => {
    const runtime = new WasmPolicyRuntime((generation) =>
      generation === 0 ? protocolWorker : delayedReadyWorker,
    );
    await runtime.identity();
    const trapped = handled(runtime.run({ operation: "fatal" }));
    await delay(100);
    await runtime.close();
    await expect(trapped).rejects.toMatchObject({ code: "worker_failure" });
    expect(runtime.generation).toBe(0);
  });

  it("types initial and replacement readiness failures without unhandled rejection", async () => {
    await withoutUnhandledRejections(async () => {
      const initial = new WasmPolicyRuntime(missingWorker);
      await expect(initial.identity()).rejects.toMatchObject({ code: "worker_readiness" });
      await initial.close();

      const replacement = new WasmPolicyRuntime((generation) =>
        generation === 0 ? protocolWorker : failedReadyWorker,
      );
      await replacement.identity();
      await expect(replacement.run({ operation: "fatal" })).rejects.toMatchObject({ code: "worker_readiness" });
      expect(replacement.generation).toBe(0);
      await replacement.close();
    });
  });
});
