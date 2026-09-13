export interface SourceBundleFile {
  readonly path: string;
  readonly contentBase64: string;
}

export interface CanonicalSourceBundle {
  readonly manifestJson: string;
  readonly files: readonly SourceBundleFile[];
}

export interface ValidatedBundleIdentity {
  readonly sourceBundleDigest: string;
  readonly policyDigest: string;
  readonly engineDigest: string;
}

export interface ActiveBundlePointer {
  readonly sourceBundleDigest: string;
  readonly generation: number;
}

export interface SourceBundleStorage {
  putIfAbsent(digest: string, bundle: CanonicalSourceBundle): Promise<"inserted" | "exists">;
  get(digest: string): Promise<CanonicalSourceBundle | undefined>;
  getActive(organizationId: string): Promise<ActiveBundlePointer | undefined>;
  compareAndSetActive(
    organizationId: string,
    expected: ActiveBundlePointer | undefined,
    nextDigest: string,
  ): Promise<ActiveBundlePointer | undefined>;
}
