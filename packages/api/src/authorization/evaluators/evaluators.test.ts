import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestSubjectDigest } from "@valet/engine/authorization";
import { SourceBundleHost } from "../bundles/host.js";
import { InMemorySourceBundleStorage } from "../bundles/in-memory-storage.js";
import { testBundle, testRequest } from "../test-bundle.js";
import { LocalValetEvaluator } from "./local-valet.js";
import { WasmPolicyRuntime } from "./wasm-runtime.js";

describe("local Valet evaluator containment", () => {
  let runtime: WasmPolicyRuntime;

  beforeEach(() => {
    runtime = new WasmPolicyRuntime();
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("evaluates through the Rust-to-WASM engine without RVM", async () => {
    const storage = new InMemorySourceBundleStorage();
    const host = new SourceBundleHost(storage, runtime);
    const bundle = await host.publish(testBundle());
    await host.activate("org-1", undefined, bundle.sourceBundleDigest);
    const evaluator = await LocalValetEvaluator.create(host, runtime);
    const request = testRequest();

    const envelope = await evaluator.evaluate(request);

    expect(envelope.decision).toEqual({
      effect: "allow",
      reasonCode: "local_valet_test",
      matchedRuleIds: ["local.test"],
      obligations: [],
      redactions: [],
    });
    expect(envelope.requestSubjectDigest).toBe(requestSubjectDigest(request));
    expect(envelope.evaluator).toEqual({ kind: "local_valet", engineDigest: bundle.engineDigest });
    expect(envelope.inputDigest).toHaveLength(64);

    const reordered = { ...request, context: { second: 2, first: 1 } };
    const sameValues = { ...request, context: { first: 1, second: 2 } };
    const changed = { ...request, context: { first: 1, second: 3 } };
    expect((await evaluator.evaluate(reordered)).inputDigest).toBe((await evaluator.evaluate(sameValues)).inputDigest);
    expect((await evaluator.evaluate(changed)).inputDigest).not.toBe(
      (await evaluator.evaluate(sameValues)).inputDigest,
    );
  });

  it("contains a 64 MiB allocation and evaluates successfully afterward", async () => {
    await expect(runtime.run({ operation: "verify_memory_containment" })).rejects.toMatchObject({
      code: "memory_limit",
    });
    await expect(runtime.run({ operation: "identity" })).resolves.toMatchObject({
      maxEngineMemoryBytes: 64 * 1024 * 1024,
    });
    const storage = new InMemorySourceBundleStorage();
    const host = new SourceBundleHost(storage, runtime);
    const bundle = await host.publish(testBundle());
    await host.activate("org-1", undefined, bundle.sourceBundleDigest);
    const evaluator = await LocalValetEvaluator.create(host, runtime);
    await expect(evaluator.evaluate(testRequest())).resolves.toMatchObject({
      decision: { effect: "allow" },
    });
  });

  it("terminates an over-deadline Rust evaluation and replaces its worker", async () => {
    const prefix = `package valet.authz\nimport rego.v1\ndecision := {"effect":"deny","reasonCode":"slow","matchedRuleIds":[],"obligations":[],"redactions":[]}\n`;
    const slowPolicy = `${prefix}${"#".repeat(1024 * 1024 - prefix.length - 1)}\n`;
    const startedAt = performance.now();
    await expect(
      runtime.run({ operation: "evaluate", bundle: testBundle(slowPolicy), input: {}, explain: "off" }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - startedAt).toBeLessThan(250);

    const storage = new InMemorySourceBundleStorage();
    const host = new SourceBundleHost(storage, runtime);
    const bundle = await host.publish(testBundle());
    await host.activate("org-1", undefined, bundle.sourceBundleDigest);
    const evaluator = await LocalValetEvaluator.create(host, runtime);
    await expect(evaluator.evaluate(testRequest())).resolves.toMatchObject({
      decision: { effect: "allow" },
    });
  });
});
