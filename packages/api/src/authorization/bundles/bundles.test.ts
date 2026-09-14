import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalEvaluatorError } from "../evaluators/errors.js";
import { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import { testBundle } from "../test-bundle.js";
import { SourceBundleHost } from "./host.js";
import { InMemorySourceBundleStorage } from "./in-memory-storage.js";

describe("source bundle host", () => {
  let runtime: WasmPolicyRuntime;
  let storage: InMemorySourceBundleStorage;
  let host: SourceBundleHost;

  beforeEach(() => {
    runtime = new WasmPolicyRuntime();
    storage = new InMemorySourceBundleStorage();
    host = new SourceBundleHost(storage, runtime);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("publishes immutable content idempotently and revalidates every load", async () => {
    const bundle = testBundle();
    const first = await host.publish(bundle);
    const second = await host.publish(bundle);
    expect(second).toEqual(first);
    expect(first.sourceBundleDigest).toHaveLength(64);
    expect(first.policyDigest).toHaveLength(64);
    expect(first.policyDigest).not.toBe(first.sourceBundleDigest);
    expect((await host.load(first.sourceBundleDigest)).identity).toEqual(first);
  });

  it("reloads an identical atomic generation CAS winner", async () => {
    const identity = await host.publish(testBundle());
    const first = await host.activate("org-1", undefined, identity.sourceBundleDigest);
    await expect(host.activate("org-1", undefined, identity.sourceBundleDigest)).resolves.toEqual(first);
    expect(await storage.getActive("org-1")).toEqual(first);
  });

  it("loads a maximum-size Rego module outside the evaluation deadline", async () => {
    const prefix = `package valet.authz\nimport rego.v1\ndecision := {"effect":"allow","reasonCode":"local_valet_test","matchedRuleIds":["local.test"],"obligations":[],"redactions":[]}\n`;
    const maxPolicy = `${prefix}${"#".repeat(1024 * 1024 - prefix.length - 1)}\n`;
    const identity = await host.publish(testBundle(maxPolicy));
    await host.activate("org-1", undefined, identity.sourceBundleDigest);
    const loaded = await host.loadActive("org-1");
    await expect(
      runtime.run({
        operation: "evaluate",
        sourceBundleDigest: loaded.identity.sourceBundleDigest,
        input: {},
        explain: "off",
      }),
    ).resolves.toMatchObject({ decision: { effect: "allow" } });
  }, 30_000);

  it("rejects corruption before publication", async () => {
    const bundle = testBundle();
    const corrupt = {
      ...bundle,
      files: [{ ...bundle.files[0], contentBase64: Buffer.from('{"changed":true}').toString("base64") }, ...bundle.files.slice(1)],
    };
    await expect(host.publish(corrupt)).rejects.toBeInstanceOf(LocalEvaluatorError);
  });
});
