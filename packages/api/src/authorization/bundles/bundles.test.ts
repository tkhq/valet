import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalEvaluatorError } from "../evaluators/errors.js";
import { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import { testBundle } from "../test-bundle.js";
import { SourceBundleHost } from "./host.js";
import { InMemorySourceBundleStorage } from "./in-memory-storage.js";
import type { ActiveBundlePointer, CanonicalSourceBundle } from "./types.js";

class CountingStorage extends InMemorySourceBundleStorage {
  activeReads = 0;
  bundleReads = 0;
  override async get(digest: string): Promise<CanonicalSourceBundle | undefined> {
    this.bundleReads++;
    return super.get(digest);
  }
  override async getActive(organizationId: string): Promise<ActiveBundlePointer | undefined> {
    this.activeReads++;
    return super.getActive(organizationId);
  }
  resetCounts(): void {
    this.activeReads = 0;
    this.bundleReads = 0;
  }
}

class CountingRuntime extends WasmPolicyRuntime {
  validations = 0;
  override run<T>(command: Record<string, unknown> & { readonly operation: string }): Promise<T> {
    if (command.operation === "validate_bundle") this.validations++;
    return super.run<T>(command);
  }
}

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

  it("caches one pointer-coherent bundle per organization", async () => {
    await runtime.close();
    const countedRuntime = new CountingRuntime();
    const countedStorage = new CountingStorage();
    runtime = countedRuntime;
    storage = countedStorage;
    host = new SourceBundleHost(storage, runtime);

    const allow = await host.publish(testBundle());
    const denyBundle = testBundle(`package valet.authz
import rego.v1
decision := {"effect":"deny","reasonCode":"changed_bundle","matchedRuleIds":["changed"],"obligations":[],"redactions":[]}
`);
    const deny = await host.publish(denyBundle);
    let orgOne = await host.activate("org-1", undefined, allow.sourceBundleDigest);
    await host.activate("org-2", undefined, allow.sourceBundleDigest);
    host = new SourceBundleHost(storage, runtime);
    countedStorage.resetCounts();
    countedRuntime.validations = 0;

    const firstOne = await host.loadActive("org-1");
    await host.loadActive("org-2");
    const initialWorkerGeneration = runtime.generation;
    await host.loadActive("org-1");
    await host.loadActive("org-2");
    expect(countedStorage.activeReads).toBe(4);
    expect(countedStorage.bundleReads).toBe(2);
    expect(countedRuntime.validations).toBe(2);
    expect(runtime.generation).toBe(initialWorkerGeneration);
    expect(host.cachedOrganizationCount).toBe(2);
    expect(runtime.loadedBundleCount).toBe(2);

    orgOne = (await storage.compareAndSetActive("org-1", orgOne, deny.sourceBundleDigest))!;
    countedStorage.resetCounts();
    countedRuntime.validations = 0;
    const changed = await host.loadActive("org-1");
    expect(changed.identity).toEqual(deny);
    expect(runtime.generation).toBe(initialWorkerGeneration + 1);
    expect(countedStorage).toMatchObject({ activeReads: 1, bundleReads: 1 });
    expect(countedRuntime.validations).toBe(1);

    orgOne = (await storage.compareAndSetActive("org-1", orgOne, deny.sourceBundleDigest))!;
    const beforeSameDigestGeneration = runtime.generation;
    const sameDigestGeneration = await host.loadActive("org-1");
    expect(sameDigestGeneration.pointer.generation).toBe(orgOne.generation);
    expect(sameDigestGeneration.identity).toEqual(deny);
    expect(runtime.generation).toBe(beforeSameDigestGeneration + 1);

    orgOne = (await storage.compareAndSetActive("org-1", orgOne, firstOne.identity.sourceBundleDigest))!;
    const rolledBack = await host.loadActive("org-1");
    expect(rolledBack.pointer).toEqual(orgOne);
    expect(rolledBack.identity).toEqual(allow);
    expect(host.cachedOrganizationCount).toBe(2);
    expect(runtime.loadedBundleCount).toBe(2);
  }, 30_000);

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
