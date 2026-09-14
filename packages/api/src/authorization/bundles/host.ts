import { LocalEvaluatorError } from "../evaluators/errors.js";
import type { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import type {
  ActiveBundlePointer,
  CanonicalSourceBundle,
  SourceBundleStorage,
  ValidatedBundleIdentity,
} from "./types.js";

interface ActiveBundleCacheEntry {
  readonly pointer: ActiveBundlePointer;
  readonly bundle: CanonicalSourceBundle;
  readonly identity: ValidatedBundleIdentity;
  readonly runtimeGeneration: number;
}

export class SourceBundleHost {
  private readonly active = new Map<string, ActiveBundleCacheEntry>();
  private readonly loading = new Map<string, { revision: string; promise: Promise<ActiveBundleCacheEntry> }>();

  constructor(
    private readonly storage: SourceBundleStorage,
    private readonly runtime: WasmPolicyRuntime,
  ) {}

  get cachedOrganizationCount(): number {
    return this.active.size;
  }

  activePointer(organizationId: string): Promise<ActiveBundlePointer | undefined> {
    return this.storage.getActive(organizationId);
  }

  async publish(bundle: CanonicalSourceBundle): Promise<ValidatedBundleIdentity> {
    const identity = await this.validate(bundle);
    await this.storage.putIfAbsent(identity.sourceBundleDigest, bundle);
    return identity;
  }

  async activate(
    organizationId: string,
    expected: ActiveBundlePointer | undefined,
    sourceBundleDigest: string,
  ): Promise<ActiveBundlePointer> {
    const { bundle } = await this.validatedStoredBundle(sourceBundleDigest);
    const next = { sourceBundleDigest, generation: (expected?.generation ?? 0) + 1 };
    const identity = await this.runtime.loadBundleForOrganization(organizationId, pointerRevision(next), sourceBundleDigest, bundle);
    const active = await this.storage.compareAndSetActive(organizationId, expected, sourceBundleDigest);
    if (active !== undefined) {
      this.active.set(organizationId, { pointer: active, bundle, identity, runtimeGeneration: this.runtime.generation });
      return active;
    }
    const winner = await this.storage.getActive(organizationId);
    if (winner?.sourceBundleDigest === sourceBundleDigest) {
      await this.loadActive(organizationId);
      return winner;
    }
    throw new LocalEvaluatorError(
      "bundle_replacement_conflict",
      `The active policy bundle for ${organizationId} changed concurrently.`,
    );
  }

  async load(sourceBundleDigest: string): Promise<{
    bundle: CanonicalSourceBundle;
    identity: ValidatedBundleIdentity;
  }> {
    const { bundle } = await this.validatedStoredBundle(sourceBundleDigest);
    const identity = await this.runtime.loadBundle(sourceBundleDigest, bundle);
    return { bundle, identity };
  }

  async loadActive(organizationId: string): Promise<{
    pointer: ActiveBundlePointer;
    bundle: CanonicalSourceBundle;
    identity: ValidatedBundleIdentity;
  }> {
    const pointer = await this.storage.getActive(organizationId);
    if (pointer === undefined) throw new LocalEvaluatorError("bundle_not_found", `Organization ${organizationId} has no active policy bundle.`);
    const revision = pointerRevision(pointer);
    const cached = this.active.get(organizationId);
    if (cached && pointerRevision(cached.pointer) === revision) {
      if (cached.runtimeGeneration === this.runtime.generation) return cached;
      const identity = await this.runtime.loadBundleForOrganization(organizationId, revision, pointer.sourceBundleDigest, cached.bundle);
      const refreshed = { ...cached, identity, runtimeGeneration: this.runtime.generation };
      this.active.set(organizationId, refreshed);
      return refreshed;
    }
    const loading = this.loading.get(organizationId);
    if (loading) {
      if (loading.revision === revision) return loading.promise;
      await loading.promise;
      return this.loadActive(organizationId);
    }
    const promise = this.loadActiveRevision(organizationId, pointer, revision);
    this.loading.set(organizationId, { revision, promise });
    try {
      return await promise;
    } finally {
      if (this.loading.get(organizationId)?.promise === promise) this.loading.delete(organizationId);
    }
  }

  private async loadActiveRevision(organizationId: string, pointer: ActiveBundlePointer, revision: string): Promise<ActiveBundleCacheEntry> {
    const { bundle } = await this.validatedStoredBundle(pointer.sourceBundleDigest);
    const identity = await this.runtime.loadBundleForOrganization(organizationId, revision, pointer.sourceBundleDigest, bundle);
    const entry = { pointer, bundle, identity, runtimeGeneration: this.runtime.generation };
    this.active.set(organizationId, entry);
    return entry;
  }

  private async validatedStoredBundle(sourceBundleDigest: string): Promise<{ bundle: CanonicalSourceBundle; identity: ValidatedBundleIdentity }> {
    const bundle = await this.storage.get(sourceBundleDigest);
    if (bundle === undefined) throw new LocalEvaluatorError("bundle_not_found", `Policy bundle ${sourceBundleDigest} was not found.`);
    const identity = await this.validate(bundle);
    if (identity.sourceBundleDigest !== sourceBundleDigest) throw new LocalEvaluatorError("invalid_bundle_or_evaluation", `Stored policy bundle ${sourceBundleDigest} revalidated as ${identity.sourceBundleDigest}.`);
    return { bundle, identity };
  }

  private validate(bundle: CanonicalSourceBundle): Promise<ValidatedBundleIdentity> {
    return this.runtime.run({ operation: "validate_bundle", bundle });
  }
}

function pointerRevision(pointer: ActiveBundlePointer): string {
  return `${pointer.generation}:${pointer.sourceBundleDigest}`;
}
