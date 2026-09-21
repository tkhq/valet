/**
 * Storage-quantity math shared by the manifest builder (create-time
 * workspace sizing, TKAI-385) and the workspace-PVC growth path
 * (`workspace-pvc.ts`). Lives in its own module so `manifest.ts` can import
 * it without a cycle (`workspace-pvc.ts` imports `WORKSPACE_VOLUME_NAME`
 * from `manifest.ts`).
 */

import { parseResourceQuantity } from "@valet/engine";

/** Fallback cap for workspace sizing and growth when
 * `K8sProviderConfig.workspaceStorageMax` is unset. */
export const DEFAULT_WORKSPACE_STORAGE_MAX = "20Gi";

/** Compatibility name for Kubernetes workspace-storage consumers. */
export const parseStorageQuantity = parseResourceQuantity;

/** Formats bytes as the largest binary suffix that divides evenly (else
 * plain bytes) — the doubles of any whole-Mi quantity stay whole. */
export function formatStorageQuantity(bytes: number): string {
  for (const [suffix, unit] of [
    ["Gi", 2 ** 30],
    ["Mi", 2 ** 20],
    ["Ki", 2 ** 10],
  ] as const) {
    if (bytes % unit === 0) return `${bytes / unit}${suffix}`;
  }
  return `${bytes}`;
}

/**
 * Clamps a requested storage quantity to a cap: the request (trimmed) when it
 * fits, the cap (trimmed) when it exceeds it (`clamped: true`), or null when
 * either quantity is unparseable — the caller falls back to its default
 * rather than provisioning an unknown size (a typo'd cap must never grant an
 * unbounded request).
 *
 * Trimmed, never verbatim: `parseStorageQuantity` trims before matching, so a
 * whitespace-padded value (`"8Gi "` survives YAML quoting) parses here — but
 * emitted verbatim it fails the CRD's quantity pattern and the CR is rejected
 * at admission, which kills the sandbox outright instead of falling back.
 */
export function clampStorageRequest(
  requested: string,
  max: string,
): { storage: string; clamped: boolean } | null {
  const requestedBytes = parseStorageQuantity(requested);
  if (requestedBytes === null || requestedBytes <= 0) return null;
  const maxBytes = parseStorageQuantity(max);
  if (maxBytes === null || maxBytes <= 0) return null;
  if (requestedBytes > maxBytes) return { storage: max.trim(), clamped: true };
  return { storage: requested.trim(), clamped: false };
}

/**
 * Multiplier applied to a bake's COMPRESSED image size to estimate the
 * uncompressed home-directory seed the workspace claim must hold before
 * `valet-home-init` finishes (TKAI-538). The seeded home (`/root/.local`
 * and siblings) is a subset of the image, so twice the compressed size
 * covers it plus the repo checkout with margin, while staying far below a
 * blanket over-provision.
 */
export const IMAGE_WORKSPACE_FLOOR_FACTOR = 2;

/**
 * Derives a workspace-storage floor from a bake's recorded compressed image
 * size. Returns a whole-Gi quantity string, or null when the size is unusable
 * (absent, zero, or not finite) — the caller then keeps the deploy floor.
 *
 * The result is only a floor. `resolveWorkspaceStorageRequest` still clamps it
 * to the configured max and never shrinks a larger repo-declared size. Rounds
 * up to whole Gi because EBS provisions in Gi and the growth path
 * (`workspace-pvc.ts`) also steps in Gi.
 */
export function imageAwareWorkspaceFloor(compressedImageBytes: number): string | null {
  if (!Number.isFinite(compressedImageBytes) || compressedImageBytes <= 0) return null;
  const gi = 2 ** 30;
  const requiredGi = Math.ceil((compressedImageBytes * IMAGE_WORKSPACE_FLOOR_FACTOR) / gi);
  return `${requiredGi}Gi`;
}

/**
 * Chooses the larger of a repo-declared workspace size and an image-derived
 * floor (TKAI-538). A declared size that already fits the image is preserved;
 * an undeclared or too-small one is lifted to the floor so `valet-home-init`
 * can seed the baked home. Returns the declared value when the floor is absent
 * or not larger, and the floor when there is no usable declared value.
 *
 * Comparison is by parsed bytes. An unparseable declared value is treated as
 * absent, so the floor applies rather than a value the provider would reject.
 */
export function liftWorkspaceStorageToImageFloor(
  declared: string | undefined,
  imageFloor: string | null,
): string | undefined {
  if (!imageFloor) return declared;
  const floorBytes = parseStorageQuantity(imageFloor);
  if (floorBytes === null) return declared;
  const declaredBytes = declared ? parseStorageQuantity(declared) : null;
  if (declaredBytes !== null && declaredBytes >= floorBytes) return declared;
  return imageFloor;
}
