import { LocalEvaluatorError } from "../evaluators/errors.js";
import type { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import type {
  ActiveBundlePointer,
  CanonicalSourceBundle,
  SourceBundleStorage,
  ValidatedBundleIdentity,
} from "./types.js";

export class SourceBundleHost {
  constructor(
    private readonly storage: SourceBundleStorage,
    private readonly runtime: WasmPolicyRuntime,
  ) {}

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
    await this.load(sourceBundleDigest);
    const active = await this.storage.compareAndSetActive(organizationId, expected, sourceBundleDigest);
    if (active === undefined) {
      throw new LocalEvaluatorError(
        "bundle_replacement_conflict",
        `The active policy bundle for ${organizationId} changed concurrently.`,
      );
    }
    return active;
  }

  async load(sourceBundleDigest: string): Promise<{
    bundle: CanonicalSourceBundle;
    identity: ValidatedBundleIdentity;
  }> {
    const bundle = await this.storage.get(sourceBundleDigest);
    if (bundle === undefined) {
      throw new LocalEvaluatorError("bundle_not_found", `Policy bundle ${sourceBundleDigest} was not found.`);
    }
    const identity = await this.validate(bundle);
    if (identity.sourceBundleDigest !== sourceBundleDigest) {
      throw new LocalEvaluatorError(
        "invalid_bundle_or_evaluation",
        `Stored policy bundle ${sourceBundleDigest} revalidated as ${identity.sourceBundleDigest}.`,
      );
    }
    return { bundle, identity };
  }

  async loadActive(organizationId: string): Promise<{
    pointer: ActiveBundlePointer;
    bundle: CanonicalSourceBundle;
    identity: ValidatedBundleIdentity;
  }> {
    const pointer = await this.storage.getActive(organizationId);
    if (pointer === undefined) {
      throw new LocalEvaluatorError("bundle_not_found", `Organization ${organizationId} has no active policy bundle.`);
    }
    const loaded = await this.load(pointer.sourceBundleDigest);
    return { pointer, ...loaded };
  }

  private validate(bundle: CanonicalSourceBundle): Promise<ValidatedBundleIdentity> {
    return this.runtime.run({ operation: "validate_bundle", bundle });
  }
}
