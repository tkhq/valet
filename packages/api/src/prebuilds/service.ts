/**
 * Prebuild orchestration service (sandbox images v2 plan, Task 3). Owns the
 * full lifecycle from "an admin/scheduler wants a build" to "the row
 * reflects the terminal build state and stale images are pruned":
 *
 *   1. `startBuild(configId)` resolves the head commit + recipe SERVICE-side
 *      via the GitHub Contents API (spec decision 8, deviation recorded
 *      below), snapshots the resolved recipe onto a new `prebuilds` row
 *      (`status: "queued"`), and dispatches to `ImageBuilder.build()`.
 *   2. `syncActiveBuilds()` (10s poll, wired from `start()`) syncs every
 *      `queued`/`building` row from `builder.status(buildId)` and, on a
 *      `pushed` transition, runs retention (keep newest 2 pushed builds per
 *      config).
 *   3. `runSchedulerPass()` (10-min interval, wired from `start()`) starts a
 *      nightly rebuild for each enabled `schedule: "nightly"` config whose
 *      newest build is >24h old AND whose head sha has drifted from the
 *      newest pushed build's sha.
 *
 * ── Deviation from the plan's "detection at build time" wording ──────────
 * Spec decision 6 says detection runs "against the cloned tree at build
 * time"; spec decision 8 says each build "records the resolved recipe on
 * its prebuilds row" (which only makes sense if the row exists BEFORE the
 * build finishes). This task picks the GitHub-API approach explicitly
 * called out in the task brief: `resolveRecipeFromGitHub` below fetches the
 * ~8 candidate lockfiles (`recipe.ts`'s `CANDIDATE_LOCKFILES`) plus
 * `.valet/prebuild.yaml` via `GET /repos/{owner}/{repo}/contents/{path}` at
 * the resolved head sha — no clone, no build-container involvement — and
 * feeds the result straight into `resolveRecipe` (Task 1, unchanged). The
 * generated Dockerfile then clones and checks out that exact sha inside the
 * build. This is cheaper than a clone-for-detection round trip and keeps
 * the "row exists with its resolved recipe before build starts" property
 * decision 8 needs.
 *
 * A content-fetch error (404 for an absent file, or any other failure) is
 * uniformly treated as "file absent" (`read()` returns `null`) — this
 * matches `resolveRecipe`'s existing contract but does NOT distinguish a
 * real absent file from a transient GitHub API hiccup. Acceptable at this
 * scale; a flaky API call just produces a recipe that's missing one step,
 * not a hard failure.
 *
 * ── Build-id tracking is in-memory, not persisted ─────────────────────────
 * `ImageBuilder.build()` returns an implementation-specific `buildId` used
 * to poll `status()`. There is no column for it on `prebuilds` (the row
 * shape is fixed by Task 1's migration) — this service keeps an in-memory
 * `Map<prebuildRowId, buildId>` instead. A process restart mid-build loses
 * the mapping, so `syncActiveBuilds` can no longer poll those builds; rather
 * than leave the rows stuck at `queued`/`building` forever, `start()` runs
 * `sweepOrphanedBuilds` once at boot to mark every still-active row `failed`
 * ("interrupted by restart") and, on the kubernetes backend, best-effort
 * `cleanupOrphan(rowId)` the BuildKit Job + git-token Secret + Dockerfile
 * ConfigMap the interrupted build left behind (so a Secret can't outlive its
 * build across a restart). A failed row is a visible, debuggable outcome —
 * the operator re-triggers the build — not silent data corruption.
 *
 * ── Retention seam ─────────────────────────────────────────────────────
 * `retention(backend, imageRefs)` deletes the actual images beyond the
 * newest 2 pushed builds per config; the `prebuilds` ROWS are never deleted
 * (they're history — the config's build log). The default implementation
 * shells `docker rmi -f` per stale image ref for the `"docker"` backend and,
 * for `"kubernetes"` (Task 5), deletes via the registry's HTTP API: a HEAD
 * on the tag's manifest (to resolve the content digest — registries only
 * accept manifest deletes by digest, not by tag) followed by a DELETE on
 * that digest. Both directions are best-effort (errors swallowed) — a
 * missing/already-gone image is not a failure. Tests inject `retention`
 * directly to assert "keeps exactly 2" without touching a real daemon or
 * registry.
 *
 * EXTERNAL-REGISTRY LIMITATION: the kubernetes retention path wires no
 * registry credentials. It works against the bundled in-cluster registry
 * (plain HTTP, no auth) but NOT against an authenticating external registry
 * — there the manifest DELETE would 401. Rather than silently no-op, the
 * default retention logs a one-line warning and skips the delete whenever the
 * registry is not insecure (i.e. external). Credentialed external-registry
 * retention is a follow-up.
 *
 * ── No token ever lands on a row or a response ────────────────────────────
 * `PrebuildSpec.gitToken` is minted fresh per `startBuild` call
 * (`resolveGitHubToken(purpose:"git")`) and handed to the builder in
 * memory; it is never written to the `prebuilds` row, never logged, and
 * never returned from any route this service backs.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { imageSources, bakes, type ImageSourceRow, type BakeRow } from "../schema/index.js";
import { ownerOf, repoOf } from "../services/session-github-token.js";
import { GitHubAuthError, resolveGitHubToken, type GitHubTokenDeps } from "../services/github-tokens.js";
import { resolveGithubApiUrl } from "../services/github-env.js";
import { resolveDefaultImage } from "../providers/sandbox-backend.js";
import { resolveRecipe, CANDIDATE_LOCKFILES, type ResolvedRecipe } from "./recipe.js";
import type { SpawnFn } from "./docker-builder.js";
import type { ImageBuilder, PrebuildSpec } from "./builder.js";
import { pushRefFor } from "./k8s-builder.js";
import { headRegistryManifest, parseRegistryImageRef } from "./registry.js";

/** Thrown by `startBuild`/`rebuild` when no `ImageBuilder` is wired
 * (`Providers.imageBuilder === null`) — routes map this to a 409 with an
 * "unavailable on this deployment" message. */
export class PrebuildUnavailableError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("prebuilds are unavailable on this deployment (no image builder is configured)");
    this.name = "PrebuildUnavailableError";
  }
}

export class PrebuildConfigNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(sourceId: string) {
    super(`image source not found: ${sourceId}`);
    this.name = "PrebuildConfigNotFoundError";
  }
}

/** Applies the org/host-slug convention documented on `PrebuildSpec.imageRef`
 * — lowercase, non-alphanumeric runs collapsed to a single `-`, no leading/
 * trailing `-`. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Default bundled in-cluster registry Service DNS name (chart's
 * `registry-service.yaml`, `valet-registry:5000`) — used when the
 * kubernetes backend's caller doesn't supply `registryHost` explicitly
 * (e.g. a test constructing `PrebuildService` without wiring
 * `VALET_PREBUILD_REGISTRY`). */
export const DEFAULT_PREBUILD_REGISTRY_HOST = "valet-registry:5000";

/**
 * `valet-prebuild/<configSlug>/<owner>-<repo>:<sha>` for the docker backend
 * (spec decision, task brief); `<registryHost>/<configSlug>/<owner>-<repo>:<sha>`
 * for the kubernetes backend (Task 5) — `registryHost` comes from
 * `VALET_PREBUILD_REGISTRY` (threaded by `startBuild`'s caller below),
 * defaulting to the bundled registry's in-cluster Service DNS name.
 *
 * The `<configSlug>` (DNS/OCI-safe lowercase of the `prebuild_configs.id`) is a
 * distinct segment in the REPOSITORY PATH — NOT the tag. Without it, two orgs
 * (or two configs) prebuilding the SAME repo at the SAME sha with different
 * bases/recipes collapse to one tag (`<host>/<owner>-<repo>:<sha>`), colliding
 * last-write-wins, and retention's kept-ref dedup — scoped per config — could
 * let one config delete another's still-referenced image. Per-config nesting
 * gives every config its own repository namespace. Registry paths allow the
 * nesting; `pushRefFor`/`parseRegistryImageRef` split on the FIRST `/` only, so
 * the extra path segment rides along untouched through host swaps + retention.
 */
export function imageRefFor(
  backend: string,
  configId: string,
  owner: string,
  repo: string,
  sha: string,
  registryHost?: string,
): string {
  const path = `${slugify(configId)}/${slugify(owner)}-${slugify(repo)}`;
  switch (backend) {
    case "kubernetes": {
      const host = registryHost ?? DEFAULT_PREBUILD_REGISTRY_HOST;
      return `${host}/${path}:${sha}`;
    }
    case "docker":
    default:
      return `valet-prebuild/${path}:${sha}`;
  }
}

/** Deletes stale prebuild IMAGES (never the `prebuilds` ROWS — those are
 * history) for backend `backend`. Docker: `docker rmi -f` per ref,
 * best-effort (errors swallowed — a missing/already-gone image is not a
 * failure). Kubernetes: registry HTTP API digest delete, same best-effort
 * contract. */
export type RetentionFn = (backend: string, imageRefs: string[]) => Promise<void>;

function dockerRmi(spawnFn: SpawnFn, imageRef: string): Promise<void> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn("docker", ["rmi", "-f", imageRef], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch {
      resolvePromise();
      return;
    }
    child.on("error", () => resolvePromise());
    child.on("close", () => resolvePromise());
  });
}

/** Deletes one image from a Docker Registry HTTP API v2 endpoint: HEAD the
 * tag's manifest (`Accept: MANIFEST_ACCEPT` — see `registry.ts`) to resolve
 * its content digest, then DELETE the manifest by that digest (registries
 * reject delete-by-tag). Best-effort — every failure (network, missing
 * `Docker-Content-Digest` header, non-2xx) is swallowed, matching
 * `dockerRmi`'s contract. Requires the registry configured with
 * `REGISTRY_STORAGE_DELETE_ENABLED=true` (set on the bundled chart's
 * registry StatefulSet) — a registry without delete enabled 4xxs the
 * DELETE, which this function silently treats the same as "already gone".
 *
 * `insecure` selects the scheme: `http` for the bundled in-cluster registry,
 * `https` otherwise. EXTERNAL-REGISTRY LIMITATION: this path wires NO
 * credentials, so against an authenticating external registry the DELETE
 * would 401 and be silently swallowed. Rather than pretend retention works
 * there, when `insecure` is false (i.e. an external registry) we log a
 * one-line warning and skip the DELETE. Full credentialed external-registry
 * retention is a follow-up (see the module docblock). */
async function registryManifestDelete(imageRef: string, fetchImpl: typeof fetch, insecure: boolean): Promise<void> {
  const parsed = parseRegistryImageRef(imageRef);
  if (!parsed) return;
  const { host, name } = parsed;
  const headRes = await headRegistryManifest(imageRef, fetchImpl, insecure);
  if (!headRes) return;
  const digest = headRes.headers.get("docker-content-digest");
  if (!digest) return;
  if (!insecure) {
    // External registry: no credential plumbing yet. Don't silently issue
    // an unauthenticated DELETE that a real registry 401s and we swallow —
    // surface the gap so operators know retention isn't happening here.
    console.warn(
      `prebuild retention: external registry retention requires credentials — skipping delete of ${imageRef}`,
    );
    return;
  }
  try {
    await fetchImpl(`http://${host}/v2/${name}/manifests/${digest}`, { method: "DELETE" });
  } catch {
    // best-effort — see docblock
  }
}

export function defaultRetention(
  spawnFn: SpawnFn = spawn as unknown as SpawnFn,
  fetchImpl: typeof fetch = fetch,
  registryInsecure = false,
  registryPushHost?: string,
): RetentionFn {
  return async (backend, imageRefs) => {
    if (imageRefs.length === 0) return;
    if (backend === "docker") {
      for (const imageRef of imageRefs) {
        await dockerRmi(spawnFn, imageRef);
      }
      return;
    }
    if (backend === "kubernetes") {
      for (const imageRef of imageRefs) {
        // Stored refs are PULL-hosted; the api pod reaches the registry over
        // the in-cluster Service DNS (PUSH host), so swap the host before the
        // manifest HEAD/DELETE. No-op when no split is configured.
        await registryManifestDelete(pushRefFor(imageRef, registryPushHost), fetchImpl, registryInsecure);
      }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function githubApiBase(deps: GitHubTokenDeps): string {
  return deps.apiUrl ?? resolveGithubApiUrl(process.env);
}

function githubFetchOf(deps: GitHubTokenDeps): typeof fetch {
  return deps.fetchImpl ?? fetch;
}

/** `token: null` sends the request unauthenticated (public-repo fallback —
 * see `resolveApiTokenOrNull` below). On a non-ok response for an
 * unauthenticated request, throws `GitHubAuthError` with a message that
 * names the actual gap ("not accessible without a credential") rather than
 * the generic HTTP-status error a caller would otherwise see — the repo is
 * either private (needs a credential) or genuinely gone. */
async function fetchGithubJson(deps: GitHubTokenDeps, token: string | null, path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Valet-App",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await githubFetchOf(deps)(`${githubApiBase(deps)}${path}`, { headers });
  if (!res.ok) {
    if (!token) {
      throw new GitHubAuthError(
        "repository not accessible without a GitHub credential — connect GitHub or install the App",
      );
    }
    throw new Error(`GitHub API ${path} responded ${res.status}`);
  }
  return res.json();
}

export interface ResolvedHead {
  sha: string;
  defaultBranch: string;
}

/** Head-sha resolution (spec decision 8, task brief): `GET
 * /repos/{owner}/{repo}` for `default_branch`, then `GET
 * /repos/{owner}/{repo}/commits/{defaultBranch}` for `sha`. Two calls —
 * `prebuild_configs` doesn't persist a default branch, so there's no way to
 * skip the first without adding a column this task's migration doesn't
 * have (disclosed deviation from "minimize calls" — two cheap metadata
 * calls, not a clone). */
export async function resolveHeadSha(
  deps: GitHubTokenDeps,
  token: string | null,
  owner: string,
  repo: string,
): Promise<ResolvedHead> {
  const repoInfo = await fetchGithubJson(deps, token, `/repos/${owner}/${repo}`);
  const defaultBranch =
    isRecord(repoInfo) && typeof repoInfo.default_branch === "string" ? repoInfo.default_branch : "main";
  const commit = await fetchGithubJson(
    deps,
    token,
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(defaultBranch)}`,
  );
  const sha = isRecord(commit) && typeof commit.sha === "string" ? commit.sha : undefined;
  if (!sha) throw new Error(`GitHub API returned no sha for ${owner}/${repo}@${defaultBranch}`);
  return { sha, defaultBranch };
}

/** Reads one file's content at `sha` via the Contents API. `null` for a
 * missing file OR any fetch/parse failure — see the module doc comment's
 * "content-fetch error" note. */
async function readGithubFile(
  deps: GitHubTokenDeps,
  token: string | null,
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await fetchGithubJson(deps, token, `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(sha)}`);
  } catch {
    return null;
  }
  if (!isRecord(payload) || typeof payload.content !== "string" || payload.encoding !== "base64") return null;
  return Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
}

/** Resolves the recipe for `owner/repo@sha` entirely via the GitHub
 * Contents API (no clone) — probes `CANDIDATE_LOCKFILES` for presence, then
 * feeds the injected `read` into `resolveRecipe` (Task 1) exactly like a
 * local-checkout caller would. */
export async function resolveRecipeFromGitHub(
  deps: GitHubTokenDeps,
  token: string | null,
  owner: string,
  repo: string,
  sha: string,
): Promise<ResolvedRecipe> {
  const read = (path: string) => readGithubFile(deps, token, owner, repo, sha, path);
  const files: string[] = [];
  for (const lockfile of CANDIDATE_LOCKFILES) {
    if ((await read(lockfile)) !== null) files.push(lockfile);
  }
  return resolveRecipe(files, read);
}

/** Resolves an `api`-purpose GitHub token for `owner/repo`, falling back to
 * `null` (unauthenticated) when NO credential is configured at all —
 * `resolveGitHubToken`'s `auto`+`api` tier throws `GitHubAuthError` rather
 * than returning `{token:null}` in that case (unlike `git`, which is
 * already tokenless-capable), and a zero-config org would otherwise be
 * unable to ever resolve a public repo's head sha/recipe (spec's exit
 * criteria explicitly requires "configure nothing" to work for public
 * repos). The credentialed path is tried FIRST (better rate limits, and
 * required for private repos) — this only kicks in when resolution itself
 * throws, not when a request later 404s. Any other error (e.g. explicit
 * `auth` mode) propagates unchanged. */
async function resolveApiTokenOrNull(
  deps: GitHubTokenDeps,
  orgId: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const result = await resolveGitHubToken(deps, { orgId, purpose: "api", repo: { owner, name: repo } });
    return result.token;
  } catch (err) {
    if (err instanceof GitHubAuthError) return null;
    throw err;
  }
}

const NIGHTLY_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_SCHEDULER_INTERVAL_MS = 10 * 60 * 1000;
/** Last-resort fallback base image when neither `.valet/prebuild.yaml`'s
 * `image`, the config's `baseImageId` (image_catalog), NOR
 * `resolveDefaultImage(env)` (`VALET_SANDBOX_IMAGE`) resolve one. Spec
 * decision 6: the fallback is the stock sandbox image — i.e. whatever
 * `VALET_SANDBOX_IMAGE` resolves to when set, same as `DockerSandboxProvider`
 * / `EngineHost`'s own default. This constant only fires when that env var
 * is unset too, mirroring `DockerSandboxProvider.create`'s own
 * `node:20-bookworm` default (see `resolveDefaultImage`'s doc comment in
 * `sandbox-backend.ts`). */
const FALLBACK_BASE_IMAGE = "node:20-bookworm";

export interface PrebuildServiceDeps {
  db: AppDb;
  /** `Providers.imageBuilder` — `null` means "prebuilds unavailable"; every
   * public method treats that as `PrebuildUnavailableError`/a silent no-op
   * (poll/scheduler passes), never a crash. */
  builder: ImageBuilder | null;
  githubTokenDeps: GitHubTokenDeps;
  now?: () => number;
  newId?: () => string;
  pollIntervalMs?: number;
  schedulerIntervalMs?: number;
  retention?: RetentionFn;
  /** Whether the prebuild registry is served over plain HTTP (the bundled
   * in-cluster registry) vs TLS (an external registry). Selects the scheme
   * the default kubernetes retention uses for its manifest HEAD/DELETE, and
   * gates the external-registry credential warning. Defaults from
   * `VALET_PREBUILD_REGISTRY_INSECURE` on `env`. Ignored when a custom
   * `retention` is injected. */
  registryInsecure?: boolean;
  /** In-cluster registry Service DNS host the api pod reaches for retention
   * deletes (the PUSH host), swapped into each stored PULL ref. Defaults from
   * `VALET_PREBUILD_REGISTRY_PUSH` on `env`; unset = no split (delete against
   * the ref's own host). Ignored when a custom `retention` is injected. */
  registryPushHost?: string;
  /** Env the stock-sandbox-image fallback is resolved from
   * (`resolveDefaultImage(env)` — `VALET_SANDBOX_IMAGE`). Defaults to
   * `process.env`; tests inject a fixture object so the fallback doesn't
   * depend on the host's ambient environment. */
  env?: NodeJS.ProcessEnv;
}

function newPrebuildId(newId: () => string): string {
  return `pb_${newId()}`;
}

export class PrebuildService {
  private readonly db: AppDb;
  private readonly builder: ImageBuilder | null;
  private readonly githubTokenDeps: GitHubTokenDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly pollIntervalMs: number;
  private readonly schedulerIntervalMs: number;
  private readonly retention: RetentionFn;
  private readonly env: NodeJS.ProcessEnv;
  /** In-memory prebuild-row-id -> builder-buildId map; see the module doc
   * comment's "Build-id tracking is in-memory" note. */
  private readonly activeBuildIds = new Map<string, string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private schedulerTimer?: ReturnType<typeof setInterval>;

  constructor(deps: PrebuildServiceDeps) {
    this.db = deps.db;
    this.builder = deps.builder;
    this.githubTokenDeps = deps.githubTokenDeps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.schedulerIntervalMs = deps.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
    this.env = deps.env ?? process.env;
    const registryInsecure = deps.registryInsecure ?? this.env.VALET_PREBUILD_REGISTRY_INSECURE === "true";
    const registryPushHost = deps.registryPushHost ?? (this.env.VALET_PREBUILD_REGISTRY_PUSH || undefined);
    this.retention = deps.retention ?? defaultRetention(undefined, undefined, registryInsecure, registryPushHost);
  }

  /** The wired builder's backend id, or `null` when prebuilds are
   * unavailable — backs `GET /api/org/prebuilds/meta`. */
  get builderBackend(): string | null {
    return this.builder?.backend ?? null;
  }

  private async loadConfig(sourceId: string): Promise<ImageSourceRow> {
    const rows = await this.db.select().from(imageSources).where(eq(imageSources.id, sourceId)).limit(1);
    const source = rows[0];
    if (!source) throw new PrebuildConfigNotFoundError(sourceId);
    return source;
  }

  /** Resolves the base image ref for a bake. Priority:
   *  1. `override` — the `.valet/prebuild.yaml` image field from the recipe.
   *  2. The source's `parent_id` — a linked base/external source whose
   *     `external_ref` (kind='external') or newest `pushed` bake's `image_ref`
   *     (kind='base') provides the base. This task uses only `external_ref`
   *     (direct external ref lookup); full parent-first base bake resolution
   *     is Task 15's job.
   *  3. `resolveDefaultImage(env)` — `VALET_SANDBOX_IMAGE`.
   *  4. `FALLBACK_BASE_IMAGE` — hardcoded `node:20-bookworm`. */
  private async resolveBaseImage(source: ImageSourceRow, override: string | undefined): Promise<string> {
    if (override) return override;
    if (source.parentId) {
      const rows = await this.db
        .select()
        .from(imageSources)
        .where(eq(imageSources.id, source.parentId))
        .limit(1);
      const parent = rows[0];
      if (parent?.externalRef) return parent.externalRef;
    }
    return resolveDefaultImage(this.env) ?? FALLBACK_BASE_IMAGE;
  }

  /** Starts a build for `sourceId`: resolves head sha + recipe via the
   * GitHub Contents API, records a `queued` `bakes` row with the
   * resolved-recipe snapshot, mints a fresh git clone token, and dispatches
   * to the builder. Throws `PrebuildUnavailableError` when no builder is
   * wired, `PrebuildConfigNotFoundError` when `sourceId` doesn't exist, and
   * propagates `GitHubAuthError` from token resolution unchanged. */
  async startBuild(sourceId: string): Promise<BakeRow> {
    if (!this.builder) throw new PrebuildUnavailableError();
    const builder = this.builder;
    const source = await this.loadConfig(sourceId);
    const repoFullName = source.repoFullName ?? "";
    const owner = ownerOf(repoFullName);
    const repo = repoOf(repoFullName);

    const apiToken = await resolveApiTokenOrNull(this.githubTokenDeps, source.orgId, owner, repo);

    const head = await resolveHeadSha(this.githubTokenDeps, apiToken, owner, repo);
    const resolved = await resolveRecipeFromGitHub(this.githubTokenDeps, apiToken, owner, repo, head.sha);
    const baseImage = await this.resolveBaseImage(source, resolved.image);

    const gitToken = await resolveGitHubToken(this.githubTokenDeps, {
      orgId: source.orgId,
      purpose: "git",
      repo: { owner, name: repo },
    });

    const imageRef = imageRefFor(builder.backend, source.id, owner, repo, head.sha, this.env.VALET_PREBUILD_REGISTRY);
    const now = this.now();
    const row: BakeRow = {
      id: newPrebuildId(this.newId),
      sourceId: source.id,
      commitSha: head.sha,
      imageRef,
      status: "queued",
      // `identity_hash` placeholder — Task 15 computes the real recipe hash.
      identityHash: "",
      builderBackend: builder.backend,
      recipe: { recipe: resolved.recipe, setup: resolved.setup, image: resolved.image },
      error: null,
      logTail: null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
    };
    await this.db.insert(bakes).values(row);

    const spec: PrebuildSpec = {
      configId: source.id,
      prebuildId: row.id,
      cloneUrl: source.cloneUrl ?? "",
      commitSha: head.sha,
      baseImage,
      recipe: resolved.recipe,
      setup: resolved.setup.length > 0 ? resolved.setup : undefined,
      imageRef,
      gitToken: gitToken.token ?? undefined,
    };
    let buildId: string;
    try {
      ({ buildId } = await builder.build(spec));
    } catch (err) {
      // `builder.build()` rejecting (e.g. daemon unreachable) must not
      // strand the row at `queued` forever — mark it failed with a readable
      // error instead of letting the route's caller see a raw 500 for a row
      // that looks otherwise fine in the DB.
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(bakes)
        .set({ status: "failed", error: message, finishedAt: this.now() })
        .where(eq(bakes.id, row.id));
      throw new Error(`prebuild build dispatch failed: ${message}`);
    }
    this.activeBuildIds.set(row.id, buildId);

    return row;
  }

  /** One poll pass: syncs every `queued`/`building` row from
   * `builder.status`, and runs retention on any row that just transitioned
   * to `pushed`. A no-op when no builder is wired. Rows this service has no
   * in-memory `buildId` for (e.g. after a process restart — see the module
   * doc comment) are left untouched, not force-failed. */
  async syncActiveBuilds(): Promise<void> {
    if (!this.builder) return;
    const builder = this.builder;
    const activeRows = await this.db
      .select()
      .from(bakes)
      .where(inArray(bakes.status, ["queued", "building"]));

    for (const row of activeRows) {
      const buildId = this.activeBuildIds.get(row.id);
      if (!buildId) continue;

      let status: Awaited<ReturnType<ImageBuilder["status"]>>;
      try {
        status = await builder.status(buildId);
      } catch {
        continue; // transient — retry next pass
      }

      if (status.state === "queued" || status.state === "building") {
        if (status.state !== row.status || status.logTail !== row.logTail) {
          await this.db
            .update(bakes)
            .set({ status: status.state, logTail: status.logTail ?? null })
            .where(eq(bakes.id, row.id));
        }
        continue;
      }

      this.activeBuildIds.delete(row.id);
      if (status.state === "pushed") {
        await this.db
          .update(bakes)
          .set({ status: "pushed", logTail: status.logTail ?? null, finishedAt: this.now() })
          .where(eq(bakes.id, row.id));
        await this.applyRetention(row.sourceId, builder.backend);
      } else {
        await this.db
          .update(bakes)
          .set({ status: "failed", error: status.error ?? null, logTail: status.logTail ?? null, finishedAt: this.now() })
          .where(eq(bakes.id, row.id));
      }
    }
  }

  /** Keeps the newest 2 `pushed` bakes per source; deletes the images
   * (never the rows) for the rest via `this.retention`. A stale row's
   * `imageRef` is excluded from deletion when a KEPT row shares the same ref
   * — a repeated-sha rebuild (re-running a build for a commit that's already
   * pushed) produces a fresh row with the same `imageRefFor(...)` value as
   * an earlier row for that sha; without this dedup, pruning the older row
   * would delete the image the kept row still points at. */
  private async applyRetention(sourceId: string, backend: string): Promise<void> {
    const pushedRows = await this.db
      .select()
      .from(bakes)
      .where(and(eq(bakes.sourceId, sourceId), eq(bakes.status, "pushed")))
      .orderBy(desc(bakes.createdAt));
    const kept = pushedRows.slice(0, 2);
    const stale = pushedRows.slice(2);
    if (stale.length === 0) return;
    const keptRefs = new Set(kept.map((r) => r.imageRef));
    const staleRefs = [...new Set(stale.map((r) => r.imageRef).filter((ref) => !keptRefs.has(ref)))];
    if (staleRefs.length === 0) return;
    await this.retention(backend, staleRefs);
  }

  /** One scheduler pass: for every enabled kind='repo' source with
   * `schedule: "nightly"`, starts a rebuild when the newest bake (any
   * status) is >24h old AND the current head sha differs from the newest
   * PUSHED bake's sha. A no-op when no builder is wired. Per-source
   * failures are logged and isolated — one bad repo/credential never blocks
   * the rest of the pass. */
  async runSchedulerPass(): Promise<void> {
    if (!this.builder) return;
    const sources = await this.db
      .select()
      .from(imageSources)
      .where(and(eq(imageSources.enabled, true), eq(imageSources.schedule, "nightly"), eq(imageSources.kind, "repo")));

    for (const source of sources) {
      try {
        await this.maybeScheduleNightly(source);
      } catch (err) {
        console.error(`prebuild scheduler: source ${source.id} (${source.repoFullName ?? "?"}) failed:`, err);
      }
    }
  }

  private async maybeScheduleNightly(source: ImageSourceRow): Promise<void> {
    const newestRows = await this.db
      .select()
      .from(bakes)
      .where(eq(bakes.sourceId, source.id))
      .orderBy(desc(bakes.createdAt))
      .limit(1);
    const newest = newestRows[0];
    if (newest && this.now() - newest.createdAt < NIGHTLY_MIN_AGE_MS) return; // fresh — skip

    const pushedRows = await this.db
      .select()
      .from(bakes)
      .where(and(eq(bakes.sourceId, source.id), eq(bakes.status, "pushed")))
      .orderBy(desc(bakes.createdAt))
      .limit(1);
    const lastPushedSha = pushedRows[0]?.commitSha;

    const repoFullName = source.repoFullName ?? "";
    const owner = ownerOf(repoFullName);
    const repo = repoOf(repoFullName);
    const apiToken = await resolveApiTokenOrNull(this.githubTokenDeps, source.orgId, owner, repo);
    const head = await resolveHeadSha(this.githubTokenDeps, apiToken, owner, repo);
    if (head.sha === lastPushedSha) return; // no change — skip

    await this.startBuild(source.id);
  }

  /** Marks every `queued`/`building` row `failed` at boot. `activeBuildIds`
   * is in-memory only (see the module doc comment's "Build-id tracking"
   * note) — any row still `queued`/`building` when the PROCESS starts (not
   * this call) necessarily belonged to a build no in-memory map entry
   * survived for, i.e. an interrupted previous process. Runs once, before
   * the poll/scheduler intervals start, so `syncActiveBuilds` never races a
   * row this sweep is about to fail. */
  private async sweepOrphanedBuilds(): Promise<void> {
    const orphaned = await this.db
      .select({ id: bakes.id })
      .from(bakes)
      .where(inArray(bakes.status, ["queued", "building"]));
    if (orphaned.length === 0) return;

    await this.db
      .update(bakes)
      .set({ status: "failed", error: "interrupted by restart", finishedAt: this.now() })
      .where(inArray(bakes.status, ["queued", "building"]));

    // Best-effort: an interrupted build may have left durable cluster
    // resources (BuildKit Job + git-token Secret + Dockerfile ConfigMap)
    // standing — the in-memory buildId map that the poll-side cleanup relies
    // on is gone after a restart, so `cleanupOrphan` deletes them by the
    // durable ROW id instead (a no-op for backends with nothing durable to
    // reclaim, e.g. docker). Isolated per row: one failing delete never
    // blocks the rest of the sweep.
    const builder = this.builder;
    if (builder?.cleanupOrphan) {
      for (const row of orphaned) {
        try {
          await builder.cleanupOrphan(row.id);
        } catch (err) {
          console.error(`prebuild sweep: cleanupOrphan(${row.id}) failed:`, err);
        }
      }
    }
  }

  /** Runs the boot-time orphan sweep, then starts the unref'd poll (10s) and
   * scheduler (10min) intervals. Idempotent — a second call while already
   * started is a no-op (it does not re-run the sweep). */
  async start(): Promise<void> {
    if (this.pollTimer || this.schedulerTimer) return;
    await this.sweepOrphanedBuilds();
    this.pollTimer = setInterval(() => {
      void this.syncActiveBuilds().catch((err) => console.error("prebuild poll pass failed:", err));
    }, this.pollIntervalMs);
    this.pollTimer.unref();
    this.schedulerTimer = setInterval(() => {
      void this.runSchedulerPass().catch((err) => console.error("prebuild scheduler pass failed:", err));
    }, this.schedulerIntervalMs);
    this.schedulerTimer.unref();
  }

  /** Clears both intervals. Safe to call even if `start()` was never
   * called. */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.pollTimer = undefined;
    this.schedulerTimer = undefined;
  }
}
