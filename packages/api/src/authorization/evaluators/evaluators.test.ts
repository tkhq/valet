import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestSubjectDigest } from "@valet/engine/authorization";
import { SourceBundleHost } from "../bundles/host.js";
import { InMemorySourceBundleStorage } from "../bundles/in-memory-storage.js";
import { testBundle, testRequest } from "../test-bundle.js";
import { LocalValetEvaluator } from "./local-valet.js";
import {
  MAX_WASM_LINEAR_MEMORY_BYTES,
  MAX_WORKER_HEAP_MIB,
  policyWorkerOptions,
  WasmPolicyRuntime,
} from "./wasm-runtime.js";

async function activeEvaluator(runtime: WasmPolicyRuntime, bundle = testBundle()) {
  const storage = new InMemorySourceBundleStorage();
  const host = new SourceBundleHost(storage, runtime);
  const identity = await host.publish(bundle);
  const pointer = await host.activate("org-1", undefined, identity.sourceBundleDigest);
  return { evaluator: await LocalValetEvaluator.create(host, runtime), host, identity, pointer };
}

describe("local Valet evaluator containment", () => {
  let runtime: WasmPolicyRuntime;

  it("keeps the Node heap limit and omits Bun's ignored worker option", () => {
    expect(policyWorkerOptions(false)).toEqual({
      resourceLimits: { maxOldGenerationSizeMb: MAX_WORKER_HEAP_MIB },
    });
    expect(policyWorkerOptions(true)).toEqual({});
  });

  beforeEach(() => {
    runtime = new WasmPolicyRuntime();
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("waits for cold readiness before evaluation", async () => {
    const { evaluator, identity } = await activeEvaluator(runtime);
    const request = testRequest();
    const envelope = await evaluator.evaluate(request);

    expect(runtime.generation).toBe(0);
    expect(envelope.decision).toEqual({
      effect: "allow",
      reasonCode: "local_valet_test",
      matchedRuleIds: ["local.test"],
      obligations: [],
      redactions: [],
    });
    expect(envelope.requestSubjectDigest).toBe(requestSubjectDigest(request));
    expect(envelope.evaluator).toEqual({ kind: "local_valet", engineDigest: identity.engineDigest });
  });

  it.each([
    {
      name: "absent",
      optionalFields: "",
      expected: { tier: "high", approverType: "team", replay: "once" },
    },
    {
      name: "present",
      optionalFields: '"approverId": "team-1", "expiresAtMs": 123,',
      expected: { tier: "high", approverType: "team", approverId: "team-1", replay: "once", expiresAtMs: 123 },
    },
  ])("preserves $name approval optionals across the TypeScript WASM boundary", async ({ optionalFields, expected }) => {
    const policy = `package valet.authz
import rego.v1
decision := {
  "effect": "require_approval",
  "reasonCode": "approval_required",
  "matchedRuleIds": ["approval.test"],
  "obligations": [],
  "redactions": [],
  "approvalRequirement": {
    "tier": "high",
    "approverType": "team",
    ${optionalFields}
    "replay": "once",
  },
}
`;
    const { evaluator } = await activeEvaluator(runtime, testBundle(policy));
    const decision = (await evaluator.evaluate(testRequest())).decision;
    expect(decision.approvalRequirement).toEqual(expected);
    expect(Object.hasOwn(decision.approvalRequirement ?? {}, "approverId")).toBe("approverId" in expected);
    expect(Object.hasOwn(decision.approvalRequirement ?? {}, "expiresAtMs")).toBe("expiresAtMs" in expected);
  });

  it("serializes concurrent requests without charging queue time", async () => {
    const { evaluator } = await activeEvaluator(runtime);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        evaluator.evaluate({ ...testRequest(), requestId: `request-${index}` }),
      ),
    );
    expect(results.map((result) => result.requestId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `request-${index}`),
    );
    expect(runtime.generation).toBe(0);
  });

  it("keeps graceful memory exhaustion distinct and leaves the worker usable", async () => {
    const generation = runtime.generation;
    await expect(runtime.run({ operation: "verify_memory_containment" })).rejects.toMatchObject({
      code: "memory_limit",
    });
    expect(runtime.generation).toBe(generation);
    await expect(runtime.identity()).resolves.toMatchObject({
      maxEngineMemoryBytes: MAX_WASM_LINEAR_MEMORY_BYTES,
    });
    await expect((await activeEvaluator(runtime)).evaluator.evaluate(testRequest())).resolves.toMatchObject({
      decision: { effect: "allow" },
    });
  });

  it("poisons a RangeError before returning a typed memory failure", async () => {
    const generation = runtime.generation;
    await expect(runtime.run({ operation: "trigger_range_error" })).rejects.toMatchObject({ code: "memory_limit" });
    expect(runtime.generation).toBe(generation + 1);
  });

  it("poisons a genuinely trapped instance before rejection and recovers cold", async () => {
    const { evaluator } = await activeEvaluator(runtime);
    const generation = runtime.generation;
    await expect(runtime.run({ operation: "trigger_trap" })).rejects.toMatchObject({ code: "engine_trap" });
    expect(runtime.generation).toBe(generation + 1);
    await expect(evaluator.evaluate(testRequest())).resolves.toMatchObject({
      decision: { effect: "allow" },
    });
  });

  it("returns deterministic fuel exhaustion without poisoning the worker", async () => {
    const policy = `package valet.authz
import rego.v1
decision := {"effect":"deny","reasonCode":"marshaled","matchedRuleIds":[],"obligations":[],"redactions":[]} if {
  output := yaml.marshal(input.values)
  startswith(output, "- ")
}
`;
    const { identity, evaluator, host, pointer } = await activeEvaluator(runtime, testBundle(policy));
    const values = Array.from({ length: 100 }, (_, index) => `value-${index}`);
    const generation = runtime.generation;
    await expect(
      runtime.run({
        operation: "evaluate",
        sourceBundleDigest: identity.sourceBundleDigest,
        input: { values },
        explain: "off",
      }),
    ).rejects.toMatchObject({ code: "evaluation_budget" });
    expect(runtime.generation).toBe(generation);

    const replacement = await host.publish(testBundle());
    await host.activate("org-1", pointer, replacement.sourceBundleDigest);
    await expect(evaluator.evaluate(testRequest())).resolves.toMatchObject({
      decision: { effect: "allow" },
    });
  });

  it("detects pointer changes and reuses immutable bundles without replacing the worker", async () => {
    const { evaluator, host, identity, pointer } = await activeEvaluator(runtime);
    const generation = runtime.generation;
    const denyBundle = testBundle(`package valet.authz
import rego.v1
decision := {"effect":"deny","reasonCode":"changed_bundle","matchedRuleIds":["changed"],"obligations":[],"redactions":[]}
`);
    const replacement = await host.publish(denyBundle);
    const changedPointer = await host.activate("org-1", pointer, replacement.sourceBundleDigest);
    await expect(evaluator.evaluate(testRequest())).resolves.toMatchObject({ decision: { effect: "deny", reasonCode: "changed_bundle" } });

    await host.activate("org-1", changedPointer, identity.sourceBundleDigest);
    await expect(evaluator.evaluate(testRequest())).resolves.toMatchObject({ decision: { effect: "allow", reasonCode: "local_valet_test" } });
    expect(runtime.generation).toBe(generation);
  });

  it("canonicalizes typed objects and rejects byte-boundary-shaped commands", async () => {
    const { evaluator, identity } = await activeEvaluator(runtime);
    const request = testRequest();
    const reordered = { ...request, context: { second: 2, first: 1 } };
    const sameValues = { ...request, context: { first: 1, second: 2 } };
    const changed = { ...request, context: { first: 1, second: 3 } };
    expect((await evaluator.evaluate(reordered)).inputDigest).toBe((await evaluator.evaluate(sameValues)).inputDigest);
    expect((await evaluator.evaluate(changed)).inputDigest).not.toBe(
      (await evaluator.evaluate(sameValues)).inputDigest,
    );
    await expect(
      runtime.run({
        operation: "evaluate",
        sourceBundleDigest: identity.sourceBundleDigest,
        canonicalInput: '{"duplicate":1,"duplicate":2}',
        explain: "off",
      }),
    ).rejects.toMatchObject({ code: "malformed_request" });
  });
});
