import { LocalEvaluatorError } from "../evaluators/errors.js";
import type {
  ActiveBundlePointer,
  CanonicalSourceBundle,
  SourceBundleStorage,
} from "./types.js";

export class InMemorySourceBundleStorage implements SourceBundleStorage {
  private readonly bundles = new Map<string, CanonicalSourceBundle>();
  private readonly active = new Map<string, ActiveBundlePointer>();

  async putIfAbsent(digest: string, bundle: CanonicalSourceBundle): Promise<"inserted" | "exists"> {
    const existing = this.bundles.get(digest);
    if (existing !== undefined) {
      if (serializeBundle(existing) !== serializeBundle(bundle)) {
        throw new LocalEvaluatorError("bundle_conflict", `Digest ${digest} already names different bytes.`);
      }
      return "exists";
    }
    this.bundles.set(digest, cloneBundle(bundle));
    return "inserted";
  }

  async get(digest: string): Promise<CanonicalSourceBundle | undefined> {
    const bundle = this.bundles.get(digest);
    return bundle === undefined ? undefined : cloneBundle(bundle);
  }

  async getActive(organizationId: string): Promise<ActiveBundlePointer | undefined> {
    const pointer = this.active.get(organizationId);
    return pointer === undefined ? undefined : { ...pointer };
  }

  async compareAndSetActive(
    organizationId: string,
    expected: ActiveBundlePointer | undefined,
    nextDigest: string,
  ): Promise<ActiveBundlePointer | undefined> {
    const current = this.active.get(organizationId);
    if (!samePointer(current, expected)) return undefined;
    const next = { sourceBundleDigest: nextDigest, generation: (current?.generation ?? 0) + 1 };
    this.active.set(organizationId, next);
    return { ...next };
  }
}

function cloneBundle(bundle: CanonicalSourceBundle): CanonicalSourceBundle {
  return Object.freeze({
    manifestJson: bundle.manifestJson,
    files: Object.freeze(bundle.files.map((file) => Object.freeze({ ...file }))),
  });
}

function serializeBundle(bundle: CanonicalSourceBundle): string {
  return JSON.stringify([bundle.manifestJson, bundle.files.map((file) => [file.path, file.contentBase64])]);
}

function samePointer(left: ActiveBundlePointer | undefined, right: ActiveBundlePointer | undefined): boolean {
  return left?.generation === right?.generation && left?.sourceBundleDigest === right?.sourceBundleDigest;
}
