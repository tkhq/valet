/**
 * Docker Registry HTTP API v2 helpers shared by prebuild RETENTION
 * (`service.ts`'s `registryManifestDelete` — resolves a tag's content digest
 * before a delete-by-digest) and session-create PULL PREFLIGHT (`resolve.ts`'s
 * `resolvePrebuildImage` — probes whether a stored image ref is actually
 * pullable before booting a sandbox from it). Only `fetch` I/O, no db.
 */
import { pushRefFor } from "./k8s-builder.js";

/** The `Accept` header sent on the manifest HEAD. BuildKit pushes OCI
 * manifests (`application/vnd.oci.image.*`) by DEFAULT, so an Accept limited
 * to the docker schema2 media types makes the registry return the manifest
 * WITHOUT a `Docker-Content-Digest` (content-type mismatch) — the HEAD then
 * yields no digest, the DELETE is skipped, and retention silently no-ops.
 * Advertise all four: docker schema2 + schema2 manifest-list, and the OCI
 * image manifest + image index, comma-joined. */
export const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
].join(", ");

/** Splits a `<host>/<name>:<tag>` ref into its parts, where `<name>` MAY itself
 * contain slashes (org-scoped paths like `<configSlug>/<owner>-<repo>`).
 * Returns `null` when the ref doesn't contain a `/` (a docker-backend-shaped
 * ref like `valet-prebuild/foo:sha` with no registry host — never expected to
 * reach a registry API call, but defensive rather than throwing). Splits on the
 * FIRST `/` for the host and the LAST `:` for the tag. */
export function parseRegistryImageRef(imageRef: string): { host: string; name: string; tag: string } | null {
  const lastColon = imageRef.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostAndName = imageRef.slice(0, lastColon);
  const tag = imageRef.slice(lastColon + 1);
  const slash = hostAndName.indexOf("/");
  if (slash < 0) return null;
  return { host: hostAndName.slice(0, slash), name: hostAndName.slice(slash + 1), tag };
}

/** HEADs a registry manifest by tag, returning the raw `Response` or `null` on
 * a parse failure / network error / timeout. `insecure` selects the scheme
 * (`http` for the bundled in-cluster registry, `https` otherwise). `timeoutMs`,
 * when set, aborts a slow registry so a caller (preflight) can bound its wait.
 * Never throws — an unreachable registry is `null`, not an exception. */
export async function headRegistryManifest(
  imageRef: string,
  fetchImpl: typeof fetch,
  insecure: boolean,
  timeoutMs?: number,
): Promise<Response | null> {
  const parsed = parseRegistryImageRef(imageRef);
  if (!parsed) return null;
  const { host, name, tag } = parsed;
  const scheme = insecure ? "http" : "https";
  try {
    return await fetchImpl(`${scheme}://${host}/v2/${name}/manifests/${tag}`, {
      method: "HEAD",
      headers: { Accept: MANIFEST_ACCEPT },
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch {
    return null;
  }
}

/** Default manifest-HEAD budget for the pull preflight — short, because it
 * runs on the hot session-create path and a slow answer means "cold-start"
 * anyway. */
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 2000;

export interface PrebuildPreflightOpts {
  /** Whether the registry is served over plain HTTP (bundled in-cluster
   * registry) vs TLS (external) — selects the HEAD scheme. */
  registryInsecure: boolean;
  /** In-cluster Service DNS host the api pod reaches the registry at (the PUSH
   * host), swapped into the stored PULL ref before the HEAD. The stored ref's
   * host is the NODE-facing pull host (e.g. `localhost:<nodePort>`), which the
   * api pod itself can't resolve; unset = no split (HEAD the ref as-is). */
  registryPushHost?: string;
  /** Injected `fetch` for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Manifest-HEAD timeout (ms). Defaults to {@link DEFAULT_PREFLIGHT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Preflights whether a stored PULL image ref is actually pullable from the
 * registry: a manifest HEAD (against the PUSH host, which the api pod can
 * resolve — the stored pull host may not be routable from here) with a short
 * timeout. `true` only on a 2xx HEAD; `false` when the registry is down/slow
 * (timeout, connection refused) OR the manifest is gone (pruned image, 404).
 *
 * The point (optimization-never-dependency): a prebuilt image ref that can no
 * longer be pulled must degrade to a COLD start, not an `ImagePullBackOff` that
 * wedges the sandbox pod — a down registry would otherwise make a prebuilt
 * session strictly WORSE than an unconfigured one. Never throws (all failure is
 * folded into `false` via `headRegistryManifest`).
 */
export async function prebuildImagePullable(imageRef: string, opts: PrebuildPreflightOpts): Promise<boolean> {
  const ref = pushRefFor(imageRef, opts.registryPushHost);
  const res = await headRegistryManifest(
    ref,
    opts.fetchImpl ?? fetch,
    opts.registryInsecure,
    opts.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS,
  );
  if (res === null) return false;
  // 401/403 means "this credential-less preflight can't tell", NOT "absent":
  // against a credentialed external registry the kubelet holds the
  // pullSecret and may well pull fine — treat auth rejections as pullable
  // rather than silently cold-starting every prebuilt session.
  return res.ok || res.status === 401 || res.status === 403;
}
