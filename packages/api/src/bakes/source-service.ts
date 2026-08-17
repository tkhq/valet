/**
 * `SourceService` — the generation-path core (sandbox-reconcile plan, Task
 * 15). Absorbs the former `PrebuildService` (docker/k8s builder dispatch,
 * poll sync, retention, orphan sweep, start/stop lifecycle — moved here
 * unchanged) and adds the reconcile-era generation logic:
 *
 *   - Content-addressed IDENTITY hashing (`identityHash`) over the resolved
 *     recipe / setup commands, chained through `parent_id` so a base-source
 *     command change ripples into its repo children's identities.
 *   - CHAINED bakes (`startBake`): a repo bake FROMs its parent base source's
 *     current bake ref; a base bake FROMs its own parent (external ref /
 *     grandparent bake / stock).
 *   - PARENT-FIRST nightly bake-or-skip (`runSchedulerPass`, spec decision
 *     14): base sources bake before their dependent repo children in the same
 *     pass. A source is skipped when its identity AND (for repos) its head sha
 *     already match the newest pushed bake.
 *   - DECAY (spec decision 13): a repo source with no LIVE session binding and
 *     `last_bound_at` older than 30 days is auto-disabled and skipped.
 *   - ZERO-CONFIG (`ensureRepoSource`, spec decision 13): binding a repo to a
 *     session upserts its repo source, touches `last_bound_at`, re-enables a
 *     decayed source, and fires the first bake in the background — gated on an
 *     org-scoped GitHub credential AND a wired builder, never throwing.
 *
 * The `ImageBuilder` port is unchanged; base bakes ride the same builder via
 * `PrebuildSpec.kind: "base"` (a data flag the builders branch their
 * Dockerfile generation on — no new port method).
 *
 * Everything the former module doc comment said about token handling, the
 * in-memory build-id map, the boot-time orphan sweep, and the retention seam
 * still holds — that machinery moved here verbatim.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import {
  imageSources,
  bakes,
  agentSessions,
  sessionRepos,
  type ImageSourceRow,
  type BakeRow,
} from "../schema/index.js";
import { ownerOf, repoOf } from "../services/session-github-token.js";
import { GitHubAuthError, resolveGitHubToken, type GitHubTokenDeps } from "../services/github-tokens.js";
import { DEFAULT_FULL_BASE_IMAGE, resolveDefaultImage } from "../providers/sandbox-backend.js";
import { resolveRecipe, loadPrebuildOverride, CANDIDATE_LOCKFILES, type ResolvedRecipe, type RecipeStep } from "../prebuilds/recipe.js";
import type { SpawnFn } from "../prebuilds/docker-builder.js";
import type { ImageBuilder, PrebuildSpec } from "../prebuilds/builder.js";
import { pushRefFor } from "../prebuilds/k8s-builder.js";
import { headRegistryManifest, parseRegistryImageRef } from "../prebuilds/registry.js";
import { resolveGithubApiUrl } from "../services/github-env.js";
import { measureBakeSize } from "../prebuilds/bake-size.js";

/** Thrown by `startBake` when no `ImageBuilder` is wired
 * (`Providers.imageBuilder === null`) — routes map this to a 409 with an
 * "unavailable on this deployment" message. */
export class PrebuildUnavailableError extends Error {
  readonly statusCode = 409;
  constructor() {
    super(
      "Image builds are unavailable on this deployment. Ask your operator to configure an image builder.",
    );
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
 * kubernetes backend's caller doesn't supply `registryHost` explicitly. */
export const DEFAULT_PREBUILD_REGISTRY_HOST = "valet-registry:5000";

/**
 * `valet-prebuild/<sourceSlug>/<owner>-<repo>:<sha>` for docker;
 * `<registryHost>/<sourceSlug>/<owner>-<repo>:<sha>` for kubernetes. The
 * `<sourceSlug>` is a distinct segment in the REPOSITORY PATH (not the tag)
 * so two sources baking the same repo at the same sha get distinct
 * namespaces — see the retention dedup note. */
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

/** Image ref for a `base` source bake — no owner/repo/sha, just the source
 * slug and the identity hash as the tag so a base rebake with the same
 * identity is a stable ref. */
export function baseImageRefFor(backend: string, sourceId: string, identityHash: string, registryHost?: string): string {
  const tag = identityHash.slice(0, 16);
  const path = `${slugify(sourceId)}/base`;
  switch (backend) {
    case "kubernetes": {
      const host = registryHost ?? DEFAULT_PREBUILD_REGISTRY_HOST;
      return `${host}/${path}:${tag}`;
    }
    case "docker":
    default:
      return `valet-prebuild/${path}:${tag}`;
  }
}

/** Deletes stale bake IMAGES (never the `bakes` ROWS — those are history). */
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

/** Deletes one image from a Docker Registry HTTP API v2 endpoint (HEAD for
 * the digest, then DELETE by digest). Best-effort — every failure is
 * swallowed. External (non-insecure) registries are skipped with a warning
 * because no credential is wired. */
async function registryManifestDelete(imageRef: string, fetchImpl: typeof fetch, insecure: boolean): Promise<void> {
  const parsed = parseRegistryImageRef(imageRef);
  if (!parsed) return;
  const { host, name } = parsed;
  const headRes = await headRegistryManifest(imageRef, fetchImpl, insecure);
  if (!headRes) return;
  const digest = headRes.headers.get("docker-content-digest");
  if (!digest) return;
  if (!insecure) {
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
  spawnFn: SpawnFn = spawn,
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

/** Head-sha resolution: `GET /repos/{owner}/{repo}` for `default_branch`,
 * then `GET /repos/{owner}/{repo}/commits/{defaultBranch}` for `sha`. */
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
 * missing file OR any fetch/parse failure. */
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
    payload = await fetchGithubJson(
      deps,
      token,
      `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(sha)}`,
    );
  } catch {
    return null;
  }
  if (!isRecord(payload) || typeof payload.content !== "string" || payload.encoding !== "base64") return null;
  return Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
}

/** Resolves the recipe for `owner/repo@sha` entirely via the GitHub Contents
 * API (no clone). */
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

const repoDockerCache = new Map<string, { value: boolean; at: number }>();
const REPO_DOCKER_TTL_MS = 10 * 60 * 1000;

/** Clears the module-level `repoDockerFlag` cache. Exposed for test isolation
 * only — production code must not call this. */
export function clearRepoDockerCache(): void {
  repoDockerCache.clear();
}

/** Best-effort read of `.valet/prebuild.yaml`'s `docker` key for a repo ref.
 * Errors (auth, rate limit, bad YAML) resolve `false`: the session still
 * starts, without docker. The session-create `docker` option is the
 * corrective override when the repo read cannot succeed.
 *
 * Results are cached per `owner/repo@ref` for 10 minutes (both `true` and
 * `false` are cached so a missing file does not generate repeated API calls). */
export async function repoDockerFlag(
  deps: GitHubTokenDeps,
  token: string | null,
  owner: string,
  repo: string,
  ref: string,
): Promise<boolean> {
  const key = `${owner}/${repo}@${ref}`;
  const hit = repoDockerCache.get(key);
  if (hit && Date.now() - hit.at < REPO_DOCKER_TTL_MS) return hit.value;
  let value = false;
  try {
    const read = (path: string) => readGithubFile(deps, token, owner, repo, ref, path);
    const override = await loadPrebuildOverride(read);
    value = override?.docker === true;
  } catch (err) {
    console.error(
      `repoDockerFlag: read failed for ${key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  // Crude size cap: clear the whole map rather than LRU-evict. The map holds
  // at most ~1000 entries (owner/repo@ref strings + booleans), which is small
  // enough in memory; clearing is O(1) and avoids the complexity of a real
  // eviction policy. A hard limit of 1000 is far beyond any realistic session
  // volume before the 10-min TTL would reclaim entries anyway.
  if (repoDockerCache.size >= 1000) repoDockerCache.clear();
  repoDockerCache.set(key, { value, at: Date.now() });
  return value;
}

/** Resolves an `api`-purpose GitHub token for `owner/repo`, falling back to
 * `null` (unauthenticated) when NO credential is configured at all. */
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
/** Decay window (spec decision 13): a repo source with no live binding and a
 * `last_bound_at` older than this is auto-disabled by the nightly pass. */
const DECAY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Canonical recipe JSON — mirrors `recipe.ts`'s private helper so the
 * identity hash covers full step content (id + lockfile + command) plus the
 * setup list, deterministic regardless of key order. */
function canonicalRecipeJson(recipe: RecipeStep[], setup: string[]): string {
  return JSON.stringify({
    steps: recipe.map((s) => ({ id: s.id, lockfile: s.lockfile, command: s.command })),
    setup,
  });
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The recipe snapshot shape `startBake` records on a bake row, and the
 * shape `identityHash` covers for a repo source. */
export interface RecipeSnapshot {
  recipe: RecipeStep[];
  setup: string[];
  image?: string;
}

function readSetupCommands(source: ImageSourceRow): string[] {
  const raw = source.setupCommands;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

export interface SourceServiceDeps {
  db: AppDb;
  builder: ImageBuilder | null;
  githubTokenDeps: GitHubTokenDeps;
  now?: () => number;
  newId?: () => string;
  pollIntervalMs?: number;
  schedulerIntervalMs?: number;
  retention?: RetentionFn;
  registryInsecure?: boolean;
  registryPushHost?: string;
  env?: NodeJS.ProcessEnv;
}

function newBakeId(newId: () => string): string {
  return `pb_${newId()}`;
}

export class SourceService {
  private readonly db: AppDb;
  private readonly builder: ImageBuilder | null;
  private readonly githubTokenDeps: GitHubTokenDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly pollIntervalMs: number;
  private readonly schedulerIntervalMs: number;
  private readonly retention: RetentionFn;
  private readonly env: NodeJS.ProcessEnv;
  /** Global baked-image cache budget in GB (spec decision 3). Enforced by
   * `enforceCacheCeiling` after each per-source retention pass. */
  private readonly cacheBudgetGb: number;
  private readonly activeBuildIds = new Map<string, string>();
  private readonly registryInsecure: boolean;
  private readonly registryPushHost: string | undefined;
  private pollTimer?: ReturnType<typeof setInterval>;
  private schedulerTimer?: ReturnType<typeof setInterval>;

  constructor(deps: SourceServiceDeps) {
    this.db = deps.db;
    this.builder = deps.builder;
    this.githubTokenDeps = deps.githubTokenDeps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.schedulerIntervalMs = deps.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
    this.env = deps.env ?? process.env;
    this.registryInsecure = deps.registryInsecure ?? this.env.VALET_PREBUILD_REGISTRY_INSECURE === "true";
    this.registryPushHost = deps.registryPushHost ?? (this.env.VALET_PREBUILD_REGISTRY_PUSH || undefined);
    this.retention = deps.retention ?? defaultRetention(undefined, undefined, this.registryInsecure, this.registryPushHost);
    // Guard: Number("") === 0 and Number(undefined) === NaN; an empty env or a
    // non-positive value must NOT collapse the budget to 0 (which would evict
    // every unprotected bake). Fall back to the 20 GB default instead.
    const budget = Number(this.env.VALET_PREBUILD_CACHE_BUDGET_GB ?? 20);
    this.cacheBudgetGb = Number.isFinite(budget) && budget > 0 ? budget : 20;
  }

  /** The wired builder's backend id, or `null` when prebuilds are
   * unavailable — backs `GET /api/org/prebuilds/meta`. */
  get builderBackend(): string | null {
    return this.builder?.backend ?? null;
  }

  private async loadSource(sourceId: string): Promise<ImageSourceRow> {
    const rows = await this.db.select().from(imageSources).where(eq(imageSources.id, sourceId)).limit(1);
    const source = rows[0];
    if (!source) throw new PrebuildConfigNotFoundError(sourceId);
    return source;
  }

  private async loadParent(source: ImageSourceRow): Promise<ImageSourceRow | null> {
    if (!source.parentId) return null;
    const rows = await this.db.select().from(imageSources).where(eq(imageSources.id, source.parentId)).limit(1);
    return rows[0] ?? null;
  }

  /** True when a source already has a bake in flight (`queued` or `building`).
   * Consulted before every dispatch (cascade, scheduler, first-bake) so a
   * cascade-then-scheduler (or two scheduler passes) never double-dispatch a
   * second bake while the first is still running. */
  async hasActiveBake(sourceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: bakes.id })
      .from(bakes)
      .where(and(eq(bakes.sourceId, sourceId), inArray(bakes.status, ["queued", "building"])))
      .limit(1);
    return rows.length > 0;
  }

  /** Newest `pushed` bake for a source, or null. */
  async currentBake(sourceId: string): Promise<BakeRow | null> {
    const rows = await this.db
      .select()
      .from(bakes)
      .where(and(eq(bakes.sourceId, sourceId), eq(bakes.status, "pushed")))
      .orderBy(desc(bakes.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Evaluates a source's PARENT for the derivation invariant: a repo bake's
   * recorded identity and its FROM image MUST derive from the SAME base bake.
   *
   * Returns a discriminated result:
   *   - `{ status: "none" }` — no parent (repo FROMs stock, identity uses
   *     stock as the parent contribution).
   *   - `{ status: "external", ref }` — external parent (ref is both the FROM
   *     image AND the identity contribution).
   *   - `{ status: "ready", bake }` — base parent with a CONSISTENT pushed
   *     bake (its `identity_hash` matches the parent's currently-computed
   *     identity). Both FROM (`bake.imageRef`) and identity
   *     (`bake.identityHash`) read from THAT bake — never recompute from
   *     commands.
   *   - `{ status: "defer" }` — base parent that is NOT ready: no pushed bake,
   *     or the newest pushed bake's identity is stale vs. the parent's
   *     currently-computed identity. A repo child MUST defer.
   */
  private async resolveParentBase(source: ImageSourceRow): Promise<
    | { status: "none" }
    | { status: "external"; ref: string | null }
    | { status: "ready"; bake: BakeRow }
    | { status: "defer" }
  > {
    const parent = await this.loadParent(source);
    if (!parent) return { status: "none" };
    if (parent.kind === "external") return { status: "external", ref: parent.externalRef ?? null };
    if (parent.kind === "base") {
      const parentBake = await this.currentBake(parent.id);
      if (!parentBake) return { status: "defer" };
      // The base parent's newest pushed bake must reflect the base's CURRENT
      // identity — otherwise the base has a pending rebake and the repo child
      // would FROM a stale layer while recording the fresh identity.
      const parentIdentity = this.baseIdentity(parent, await this.grandparentIdentity(parent));
      if (parentBake.identityHash !== parentIdentity) return { status: "defer" };
      return { status: "ready", bake: parentBake };
    }
    return { status: "none" };
  }

  /** The identity contribution of a BASE source's own parent (external ref /
   * grandparent base bake / stock). Used only to recompute a base's current
   * identity for the consistency check in `resolveParentBase`. */
  private async grandparentIdentity(base: ImageSourceRow): Promise<string | null> {
    const gp = await this.loadParent(base);
    if (!gp) return null;
    if (gp.kind === "external") return gp.externalRef ?? null;
    if (gp.kind === "base") {
      const gpBake = await this.currentBake(gp.id);
      return gpBake ? gpBake.identityHash : this.baseIdentity(gp, null);
    }
    return null;
  }

  /** Resolves the base image ref a bake FROMs. Priority:
   *  1. `override` — `.valet/prebuild.yaml`'s `image` (repo only).
   *  2. The parent source: external → its `external_ref`; base → its current
   *     CONSISTENT pushed bake's `image_ref` (chained bake). A non-ready base
   *     parent falls through to stock (callers must have already deferred).
   *  3. `stockBaseRef()` — the shared stock chain (`VALET_FULL_BASE_IMAGE`
   *     → deprecated `VALET_SANDBOX_IMAGE` → `DEFAULT_FULL_BASE_IMAGE`),
   *     also used by `identityHash` so FROM and identity always agree. */
  private async resolveBaseImage(source: ImageSourceRow, override: string | undefined): Promise<string> {
    if (override) return override;
    const parentBase = await this.resolveParentBase(source);
    if (parentBase.status === "external" && parentBase.ref) return parentBase.ref;
    if (parentBase.status === "ready") return parentBase.bake.imageRef;
    return this.stockBaseRef();
  }

  /** The stock ref an unparented source falls back to. ONE chain for both
   * the FROM (`resolveBaseImage`) and the identity (`identityHash` /
   * `baseIdentity`): a divergent identity re-FROMs without re-identifying
   * (stale bakes never rebake on a pin change) or re-identifies without
   * re-FROMing (pointless rebakes). */
  private stockBaseRef(): string {
    return this.env.VALET_FULL_BASE_IMAGE ?? resolveDefaultImage(this.env) ?? DEFAULT_FULL_BASE_IMAGE;
  }

  /** The identity that a PARENT source contributes to its child's identity
   * hash. Reads from the SAME consistent base bake `resolveBaseImage` FROMs:
   *   - external parent → its ref.
   *   - base parent with a consistent pushed bake → that bake's identity_hash.
   *   - no parent OR a non-ready base parent → null (falls to stock). Callers
   *     that must not diverge (repo bakes) defer before reaching this state. */
  private async parentIdentity(source: ImageSourceRow): Promise<string | null> {
    const parentBase = await this.resolveParentBase(source);
    if (parentBase.status === "external") return parentBase.ref;
    if (parentBase.status === "ready") return parentBase.bake.identityHash;
    return null;
  }

  /** Content-addressed identity for a `base` source. */
  private baseIdentity(source: ImageSourceRow, parentIdentity: string | null): string {
    const stock = this.stockBaseRef();
    const parent = parentIdentity ?? stock;
    return sha256Hex(`${parent}|${canonicalRecipeJson([], readSetupCommands(source))}`);
  }

  /**
   * Content-addressed identity for a source, chained through its parent.
   * `parentIdentity` is the parent's contribution (see `parentIdentity`);
   * pass it explicitly so the hash is a pure function of its inputs (unit
   * tests pin this without DB reads).
   *
   *   external/stock → the ref itself (or the stock ref when none).
   *   base           → sha256(parentIdentity ?? stock | JSON(setup_commands)).
   *   repo           → sha256(parentIdentity ?? stock | repoFullName | recipeHash),
   *                    where recipeHash covers the RESOLVED recipe snapshot.
   */
  identityHash(source: ImageSourceRow, parentIdentity: string | null, recipe?: RecipeSnapshot): string {
    const stock = this.stockBaseRef();
    if (source.kind === "external") return source.externalRef ?? stock;
    if (source.kind === "base") return this.baseIdentity(source, parentIdentity);
    // repo
    const parent = parentIdentity ?? stock;
    const recipeHash = sha256Hex(canonicalRecipeJson(recipe?.recipe ?? [], recipe?.setup ?? []));
    return sha256Hex(`${parent}|${source.repoFullName ?? ""}|${recipeHash}`);
  }

  /** Starts a bake for `sourceId`. `repo` kind clones + runs the resolved
   * recipe; `base` kind layers `setup_commands` on the parent/stock image
   * with no clone. Records the real `identity_hash` and the recipe snapshot.
   * Throws `PrebuildUnavailableError` when no builder is wired,
   * `PrebuildConfigNotFoundError` for an unknown source, and propagates
   * `GitHubAuthError` from token resolution unchanged. */
  async startBake(sourceId: string): Promise<BakeRow> {
    if (!this.builder) throw new PrebuildUnavailableError();
    const source = await this.loadSource(sourceId);
    if (source.kind === "base") return this.startBaseBake(source);
    if (source.kind === "repo") return this.startRepoBake(source);
    throw new Error(`cannot bake source of kind '${source.kind}' (${source.id})`);
  }

  private async startBaseBake(source: ImageSourceRow): Promise<BakeRow> {
    const builder = this.builder;
    if (!builder) throw new PrebuildUnavailableError();
    const setup = readSetupCommands(source);
    const parentIdent = await this.parentIdentity(source);
    const baseImage = await this.resolveBaseImage(source, undefined);
    const identity = this.baseIdentity(source, parentIdent);
    const imageRef = baseImageRefFor(builder.backend, source.id, identity, this.env.VALET_PREBUILD_REGISTRY);

    const now = this.now();
    const row: BakeRow = {
      id: newBakeId(this.newId),
      sourceId: source.id,
      commitSha: null,
      imageRef,
      status: "queued",
      identityHash: identity,
      builderBackend: builder.backend,
      recipe: { recipe: [], setup, image: undefined },
      error: null,
      logTail: null,
      startedAt: now,
      finishedAt: null,
      sizeBytes: null,
      createdAt: now,
    };
    await this.db.insert(bakes).values(row);

    const spec: PrebuildSpec = {
      kind: "base",
      configId: source.id,
      prebuildId: row.id,
      cloneUrl: "",
      commitSha: "",
      baseImage,
      recipe: [],
      setup: setup.length > 0 ? setup : undefined,
      imageRef,
    };
    return this.dispatch(builder, row, spec);
  }

  /** The org's kind='base' profile='full' source id — the ONE base every
   * repo source parents at (single lineage) — or null when the org has not
   * been seeded yet. */
  private async defaultBaseId(orgId: string): Promise<string | null> {
    const baseSource = await this.db
      .select({ id: imageSources.id })
      .from(imageSources)
      .where(and(eq(imageSources.orgId, orgId), eq(imageSources.kind, "base"), eq(imageSources.profile, "full")))
      .limit(1);
    return baseSource[0]?.id ?? null;
  }

  /** The parent a re-bound repo source should have. Heals a null parent and
   * a legacy headless-base parent onto the default-full base; any other
   * parent (external, custom base) is kept as-is. Falls back to the current
   * parent when the full base is not seeded yet. */
  private async adoptedParentIdFor(orgId: string, currentParentId: string | null): Promise<string | null> {
    if (currentParentId === null) return this.defaultBaseId(orgId);
    const parentRows = await this.db
      .select({ kind: imageSources.kind, profile: imageSources.profile })
      .from(imageSources)
      .where(eq(imageSources.id, currentParentId))
      .limit(1);
    const parent = parentRows[0];
    if (parent && parent.kind === "base" && parent.profile === "headless") {
      return (await this.defaultBaseId(orgId)) ?? currentParentId;
    }
    return currentParentId;
  }

  /** True when a repo source must DEFER its bake because its parent is a base
   * source without a consistent pushed bake. Deferring keeps a repo's recorded
   * identity and its FROM image derived from the SAME base bake — a repo baked
   * while its base is un-pushed would FROM stock but record the new base
   * identity, then skip forever with the base layer never landing. */
  private async repoBakeDefers(source: ImageSourceRow): Promise<boolean> {
    if (source.kind !== "repo") return false;
    const parentBase = await this.resolveParentBase(source);
    return parentBase.status === "defer";
  }

  private async startRepoBake(source: ImageSourceRow): Promise<BakeRow> {
    const builder = this.builder;
    if (!builder) throw new PrebuildUnavailableError();
    const repoFullName = source.repoFullName ?? "";
    const owner = ownerOf(repoFullName);
    const repo = repoOf(repoFullName);

    const apiToken = await resolveApiTokenOrNull(this.githubTokenDeps, source.orgId, owner, repo);
    const head = await resolveHeadSha(this.githubTokenDeps, apiToken, owner, repo);
    const resolved = await resolveRecipeFromGitHub(this.githubTokenDeps, apiToken, owner, repo, head.sha);
    const baseImage = await this.resolveBaseImage(source, resolved.image);

    const snapshot: RecipeSnapshot = { recipe: resolved.recipe, setup: resolved.setup, image: resolved.image };
    const parentIdent = await this.parentIdentity(source);
    const identity = this.identityHash(source, parentIdent, snapshot);

    const gitToken = await resolveGitHubToken(this.githubTokenDeps, {
      orgId: source.orgId,
      purpose: "git",
      repo: { owner, name: repo },
    });

    const imageRef = imageRefFor(builder.backend, source.id, owner, repo, head.sha, this.env.VALET_PREBUILD_REGISTRY);
    const now = this.now();
    const row: BakeRow = {
      id: newBakeId(this.newId),
      sourceId: source.id,
      commitSha: head.sha,
      imageRef,
      status: "queued",
      identityHash: identity,
      builderBackend: builder.backend,
      recipe: snapshot,
      error: null,
      logTail: null,
      startedAt: now,
      finishedAt: null,
      sizeBytes: null,
      createdAt: now,
    };
    await this.db.insert(bakes).values(row);

    const spec: PrebuildSpec = {
      kind: "repo",
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
    return this.dispatch(builder, row, spec);
  }

  /** Dispatches a prepared spec to the builder, marking the row failed (never
   * stranded at queued) when `builder.build()` rejects. */
  private async dispatch(builder: ImageBuilder, row: BakeRow, spec: PrebuildSpec): Promise<BakeRow> {
    let buildId: string;
    try {
      ({ buildId } = await builder.build(spec));
    } catch (err) {
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

  /** Back-compat alias for the former `PrebuildService.startBuild` — the
   * rebuild route calls this. */
  async startBuild(sourceId: string): Promise<BakeRow> {
    return this.startBake(sourceId);
  }

  /** One poll pass: syncs every `queued`/`building` row from
   * `builder.status`, and runs retention on any row that just transitioned to
   * `pushed`. A no-op when no builder is wired. */
  async syncActiveBuilds(): Promise<void> {
    if (!this.builder) return;
    const builder = this.builder;
    const activeRows = await this.db.select().from(bakes).where(inArray(bakes.status, ["queued", "building"]));

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
        try {
          const size = await measureBakeSize(builder.backend, row.imageRef, {
            spawnFn: spawn,
            fetchImpl: fetch,
            registryInsecure: this.registryInsecure,
            registryPushHost: this.registryPushHost,
          });
          if (size !== null) {
            await this.db.update(bakes).set({ sizeBytes: size }).where(eq(bakes.id, row.id));
          }
        } catch {
          // best-effort — size measurement never blocks the push transition
        }
        await this.applyRetention(row.sourceId, builder.backend);
        const src = (await this.db.select().from(imageSources).where(eq(imageSources.id, row.sourceId)).limit(1))[0];
        if (src) await this.enforceCacheCeiling(src.orgId, builder.backend);
        await this.cascadeBaseChildren(row.sourceId);
      } else {
        await this.db
          .update(bakes)
          .set({ status: "failed", error: status.error ?? null, logTail: status.logTail ?? null, finishedAt: this.now() })
          .where(eq(bakes.id, row.id));
      }
    }
  }

  /** Keeps the newest 2 `pushed` bakes per source; deletes the images (never
   * the rows) for the rest via `this.retention`, deduping any imageRef a kept
   * row still references. */
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

  /**
   * Global size ceiling (spec decision 3): evicts OLD baked images across an
   * org until the total pushed-bake size is at or under the configured budget
   * (`VALET_PREBUILD_CACHE_BUDGET_GB`, default 20). Two bake sets are NEVER
   * evicted:
   *   1. Each source's NEWEST pushed bake (its current image).
   *   2. Any bake a LIVE (active/hibernated) session booted from
   *      (`agent_sessions.bake_id`).
   * Evicts oldest-first: for each victim it deletes the image via
   * `this.retention` (skipping the image delete when a KEPT or not-yet-evicted
   * bake still references the same ref — but ALWAYS deleting the row) and
   * subtracts its size. If the org is still over budget but only protected
   * bakes remain, it warns ONCE and stops. Never throws.
   */
  private async enforceCacheCeiling(orgId: string, backend: string): Promise<void> {
    try {
      const rows = await this.db
        .select({
          id: bakes.id,
          sourceId: bakes.sourceId,
          imageRef: bakes.imageRef,
          sizeBytes: bakes.sizeBytes,
          createdAt: bakes.createdAt,
        })
        .from(bakes)
        .innerJoin(imageSources, eq(bakes.sourceId, imageSources.id))
        .where(and(eq(imageSources.orgId, orgId), eq(bakes.status, "pushed")))
        .orderBy(bakes.createdAt);

      if (rows.length === 0) return;

      const budget = this.cacheBudgetGb * 1_000_000_000;
      let total = rows.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0);
      if (total <= budget) return;

      // Protected: each source's newest pushed bake id.
      const protectedIds = new Set<string>();
      const newestPerSource = new Map<string, { id: string; createdAt: number }>();
      for (const r of rows) {
        const cur = newestPerSource.get(r.sourceId);
        if (!cur || r.createdAt > cur.createdAt) {
          newestPerSource.set(r.sourceId, { id: r.id, createdAt: r.createdAt });
        }
      }
      for (const v of newestPerSource.values()) protectedIds.add(v.id);

      // Protected: any bake a live (active/hibernated) session booted from.
      const liveBakeRows = await this.db
        .select({ bakeId: agentSessions.bakeId })
        .from(agentSessions)
        .where(and(eq(agentSessions.orgId, orgId), inArray(agentSessions.status, ["active", "hibernated"])));
      for (const s of liveBakeRows) {
        if (s.bakeId) protectedIds.add(s.bakeId);
      }

      // Remaining rows still in the cache (kept OR not-yet-evicted). Used to
      // decide whether an evicted ref is still referenced elsewhere.
      const remaining = new Set(rows.map((r) => r.id));

      for (const victim of rows) {
        if (total <= budget) break;
        if (protectedIds.has(victim.id)) continue;

        remaining.delete(victim.id);
        // Skip the image delete when any OTHER remaining bake (kept or pending
        // eviction) still references the same ref — but always delete the row.
        const refStillUsed = rows.some((r) => remaining.has(r.id) && r.imageRef === victim.imageRef);
        if (!refStillUsed) {
          await this.retention(backend, [victim.imageRef]);
        }
        await this.db.delete(bakes).where(eq(bakes.id, victim.id));
        total -= victim.sizeBytes ?? 0;
      }

      if (total > budget) {
        const gb = (n: number) => (n / 1_000_000_000).toFixed(2);
        console.warn(
          `prebuild cache over budget (${gb(total)}gb > ${gb(budget)}gb) but all remaining bakes are protected`,
        );
      }
    } catch (err) {
      console.error(`prebuild cache ceiling for org ${orgId} failed:`, err);
    }
  }

  /**
   * Same-night cascade (spec decision 14): when a base bake flips to `pushed`,
   * immediately evaluate that base's ENABLED repo children and start a bake for
   * each stale one. A base build takes minutes, so its dependents land the same
   * night rather than waiting for the next 10-min scheduler tick (which would
   * also fire — this is the belt). Uses the same skip/defer rules as the
   * scheduler; per-child failures are isolated.
   */
  private async cascadeBaseChildren(sourceId: string): Promise<void> {
    const parentRows = await this.db.select().from(imageSources).where(eq(imageSources.id, sourceId)).limit(1);
    const parent = parentRows[0];
    if (!parent || parent.kind !== "base") return;

    const children = await this.db
      .select()
      .from(imageSources)
      .where(and(eq(imageSources.parentId, sourceId), eq(imageSources.kind, "repo")));

    for (const child of children) {
      try {
        if (this.schedulingBlocked(child)) continue;
        // Defer if the just-pushed base bake is still not consistent (e.g. the
        // base already has a newer pending rebake).
        if (await this.repoBakeDefers(child)) continue;

        const owner = ownerOf(child.repoFullName ?? "");
        const repo = repoOf(child.repoFullName ?? "");
        const apiToken = await resolveApiTokenOrNull(this.githubTokenDeps, child.orgId, owner, repo);
        const head = await resolveHeadSha(this.githubTokenDeps, apiToken, owner, repo);
        const resolved = await resolveRecipeFromGitHub(this.githubTokenDeps, apiToken, owner, repo, head.sha);
        const snapshot: RecipeSnapshot = { recipe: resolved.recipe, setup: resolved.setup, image: resolved.image };
        const parentIdent = await this.parentIdentity(child);
        const identity = this.identityHash(child, parentIdent, snapshot);

        const current = await this.currentBake(child.id);
        if (current && current.commitSha === head.sha && current.identityHash === identity) continue;
        // Skip when a bake is already in flight — the scheduler tick may race
        // this cascade for the same child.
        if (await this.hasActiveBake(child.id)) continue;

        console.log(`prebuild cascade: kick ${child.name}: base bake pushed`);
        await this.startBake(child.id);
      } catch (err) {
        console.error(`prebuild cascade: child ${child.id} (${child.repoFullName ?? child.name}) failed:`, err);
      }
    }
  }

  /** True when a live (active/hibernated) session has `repoFullName` bound. */
  private async hasLiveBinding(orgId: string, host: string, repoFullName: string): Promise<boolean> {
    const rows = await this.db
      .select({ sessionId: sessionRepos.sessionId })
      .from(sessionRepos)
      .innerJoin(agentSessions, eq(sessionRepos.sessionId, agentSessions.id))
      .where(
        and(
          eq(sessionRepos.host, host),
          eq(sessionRepos.fullName, repoFullName),
          eq(agentSessions.orgId, orgId),
          inArray(agentSessions.status, ["active", "hibernated"]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * One scheduler pass, PARENT-FIRST (spec decision 14): base sources bake
   * before their dependent repo children in the same pass. Per source:
   *   - disabled or `schedule: "off"` → skip.
   *   - `repo`: resolve head sha + current identity; skip when the newest
   *     pushed bake has the SAME commit sha AND identity. Decay: when no live
   *     session binds the repo AND `last_bound_at` is older than 30 days,
   *     auto-disable and skip.
   *   - `base`: skip when the identity is unchanged.
   * A no-op when no builder is wired. Per-source failures are isolated.
   */
  async runSchedulerPass(): Promise<void> {
    if (!this.builder) return;
    const all = await this.db.select().from(imageSources);
    // Parent-first: base (and external, though it never bakes) before repo.
    const bases = all.filter((s) => s.kind === "base");
    const repos = all.filter((s) => s.kind === "repo");

    for (const source of [...bases, ...repos]) {
      try {
        if (source.kind === "base") await this.maybeScheduleBase(source);
        else if (source.kind === "repo") await this.maybeScheduleRepo(source);
      } catch (err) {
        console.error(`prebuild scheduler: source ${source.id} (${source.repoFullName ?? source.name}) failed:`, err);
      }
    }
  }

  private schedulingBlocked(source: ImageSourceRow): boolean {
    return !source.enabled || source.schedule === "off";
  }

  private async maybeScheduleBase(source: ImageSourceRow): Promise<void> {
    if (this.schedulingBlocked(source)) return;
    const parentIdent = await this.parentIdentity(source);
    const identity = this.baseIdentity(source, parentIdent);
    const current = await this.currentBake(source.id);
    if (current && current.identityHash === identity) {
      console.log(`prebuild scheduler: skip ${source.name}: up to date`);
      return;
    }
    // Skip when a base bake is already in flight — a prior scheduler tick may
    // have dispatched one that has not pushed yet.
    if (await this.hasActiveBake(source.id)) {
      console.log(`prebuild scheduler: skip ${source.name}: bake already in flight`);
      return;
    }
    await this.startBake(source.id);
  }

  private async maybeScheduleRepo(source: ImageSourceRow): Promise<void> {
    if (this.schedulingBlocked(source)) return;

    // Defer when the parent base has no consistent pushed bake yet — the
    // push-kick in `syncActiveBuilds` (or the next scheduler tick) rebakes.
    if (await this.repoBakeDefers(source)) {
      console.log(`prebuild scheduler: defer ${source.name}: waiting for base bake`);
      return;
    }

    const repoHost = source.repoHost ?? "github";
    const repoFullName = source.repoFullName ?? "";

    // Decay (spec decision 13): no live binding AND untouched for 30d.
    const live = await this.hasLiveBinding(source.orgId, repoHost, repoFullName);
    if (!live) {
      const lastBound = source.lastBoundAt ?? source.createdAt;
      if (this.now() - lastBound > DECAY_AGE_MS) {
        await this.db
          .update(imageSources)
          .set({ enabled: false, updatedAt: this.now() })
          .where(eq(imageSources.id, source.id));
        console.log(`prebuild scheduler: decay ${source.name}: no live binding for 30d — disabled`);
        return;
      }
    }

    const owner = ownerOf(repoFullName);
    const repo = repoOf(repoFullName);
    const apiToken = await resolveApiTokenOrNull(this.githubTokenDeps, source.orgId, owner, repo);
    const head = await resolveHeadSha(this.githubTokenDeps, apiToken, owner, repo);
    const resolved = await resolveRecipeFromGitHub(this.githubTokenDeps, apiToken, owner, repo, head.sha);
    const snapshot: RecipeSnapshot = { recipe: resolved.recipe, setup: resolved.setup, image: resolved.image };
    const parentIdent = await this.parentIdentity(source);
    const identity = this.identityHash(source, parentIdent, snapshot);

    const current = await this.currentBake(source.id);
    if (current && current.commitSha === head.sha && current.identityHash === identity) {
      console.log(`prebuild scheduler: skip ${source.name}: up to date`);
      return;
    }
    // Skip when a bake is already in flight — a cascade (or a prior scheduler
    // tick) may have dispatched a bake for this source that has not pushed yet.
    if (await this.hasActiveBake(source.id)) {
      console.log(`prebuild scheduler: skip ${source.name}: bake already in flight`);
      return;
    }
    // Reuse the resolved head/recipe by baking through startRepoBake, which
    // re-resolves — acceptable (a second cheap metadata call); the skip check
    // above already gated the expensive builder dispatch.
    await this.startBake(source.id);
  }

  /**
   * Zero-config repo source (spec decision 13). Upserts the repo source for
   * `repo` in `orgId`: on insert, parents it to the org's base source if one
   * exists and fires the first bake; on conflict, touches `last_bound_at`,
   * re-enables a decayed source, and fires a bake when the source has no
   * pushed bake yet. NEVER throws. The bake is gated on an org-scoped GitHub
   * credential AND a wired builder; when either is missing the source is
   * still upserted and the bake is skipped with one log line.
   */
  async ensureRepoSource(
    orgId: string,
    repo: { host: string; fullName: string; cloneUrl: string },
  ): Promise<void> {
    try {
      const existing = await this.db
        .select()
        .from(imageSources)
        .where(
          and(
            eq(imageSources.orgId, orgId),
            eq(imageSources.kind, "repo"),
            eq(imageSources.repoHost, repo.host),
            eq(imageSources.repoFullName, repo.fullName),
          ),
        )
        .limit(1);
      const now = this.now();

      if (existing[0]) {
        const source = existing[0];
        // Re-bind heals two legacy parent shapes onto the org's default-full
        // base (single lineage):
        //  - parent_id null (source predates base seeding) → bakes FROM the
        //    raw stock image and the clone step fails (no git).
        //  - parent = a retired headless base → bakes miss the toolchain and
        //    the start scripts.
        // The parent change moves the identity; the nightly scheduler then
        // rebakes on the proper lineage.
        const adoptedParentId = await this.adoptedParentIdFor(orgId, source.parentId);
        await this.db
          .update(imageSources)
          .set({
            lastBoundAt: now,
            enabled: true,
            updatedAt: now,
            ...(adoptedParentId !== source.parentId ? { parentId: adoptedParentId } : {}),
          })
          .where(eq(imageSources.id, source.id));
        // Fire a bake when this re-bound source has no pushed bake yet.
        const current = await this.currentBake(source.id);
        if (!current) await this.maybeFireFirstBake(source.id, orgId, repo);
        return;
      }

      // Parent at the default-full base so the bake inherits the whole
      // sandbox toolchain (single lineage). Fall back to null (no parent)
      // if the base is not seeded yet — defensive; post-seed this should
      // not happen.
      const parentId = await this.defaultBaseId(orgId);

      const id = `src_${this.newId()}`;
      await this.db.insert(imageSources).values({
        id,
        orgId,
        kind: "repo",
        parentId,
        name: repo.fullName,
        externalRef: null,
        pullSecretName: null,
        setupCommands: null,
        repoHost: repo.host,
        repoFullName: repo.fullName,
        cloneUrl: repo.cloneUrl,
        schedule: "nightly",
        enabled: true,
        lastBoundAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await this.maybeFireFirstBake(id, orgId, repo);
    } catch (err) {
      console.error(`ensureRepoSource(${orgId}, ${repo.fullName}) failed:`, err);
    }
  }

  /** Best-effort first bake for a zero-config source. Gated on a wired
   * builder AND an org-scoped GitHub credential (installation/PAT — a
   * user-only credential cannot build, existing invariant). Skips silently
   * with one log line otherwise. Never throws. */
  private async maybeFireFirstBake(
    sourceId: string,
    orgId: string,
    repo: { fullName: string },
  ): Promise<void> {
    if (!this.builder) {
      console.log(`ensureRepoSource: no image builder — skipping first bake of ${repo.fullName}`);
      return;
    }
    const owner = ownerOf(repo.fullName);
    const name = repoOf(repo.fullName);
    let hasOrgCredential = false;
    try {
      // `userId` omitted → `auto` cannot resolve a user-only credential, so a
      // non-null token here is org-scoped (installation/PAT). Guard on
      // `source` too so a future change never lets a user credential build.
      const result = await resolveGitHubToken(this.githubTokenDeps, {
        orgId,
        purpose: "git",
        repo: { owner, name },
      });
      hasOrgCredential = result.token !== null && result.source !== "user";
    } catch {
      hasOrgCredential = false;
    }
    if (!hasOrgCredential) {
      console.log(`ensureRepoSource: no org GitHub credential — skipping first bake of ${repo.fullName}`);
      return;
    }
    // Defer when the parent base has no consistent pushed bake yet — the base
    // bake's push-kick (or the next scheduler tick) fires this repo bake.
    let source: ImageSourceRow;
    try {
      source = await this.loadSource(sourceId);
    } catch {
      return;
    }
    if (await this.repoBakeDefers(source)) {
      console.log(`ensureRepoSource: defer ${repo.fullName}: waiting for base bake`);
      return;
    }
    // Skip when a bake is already in flight — a cascade or scheduler tick may
    // have dispatched one between the caller's currentBake check and here.
    if (await this.hasActiveBake(sourceId)) {
      console.log(`ensureRepoSource: skip ${repo.fullName}: bake already in flight`);
      return;
    }
    try {
      await this.startBake(sourceId);
    } catch (err) {
      console.error(`ensureRepoSource: first bake of ${repo.fullName} failed:`, err);
    }
  }

  /**
   * Idempotent seeding of the two default base rows every org needs
   * (single image lineage — see docs/specs/2026-08-16-single-image-lineage-design.md):
   *
   *   1. `kind='external'`, `name='stock-full'` — the CI-published sandbox
   *      image (ghcr.io/tkhq/valet-sandbox or VALET_FULL_BASE_IMAGE). Re-seed
   *      follows deploy pin changes.
   *   2. `kind='base'`, `profile='full'` — parent = the stock-full external row;
   *      empty setup_commands (the full image ships everything already).
   *
   * A legacy `profile='headless'` base row from before the single-lineage
   * change is disabled (nothing resolves it; an enabled row keeps burning a
   * nightly bake).
   *
   * Never throws — errors are logged and swallowed so org creation is not
   * blocked by a seed failure. Safe to call repeatedly.
   */
  async seedDefaultBasesIfMissing(orgId: string): Promise<void> {
    const fullBaseImage = this.env.VALET_FULL_BASE_IMAGE ?? DEFAULT_FULL_BASE_IMAGE;
    const now = this.now();

    // Step 1 — ensure the stock-full external row exists.
    const existingExternal = await this.db
      .select({ id: imageSources.id })
      .from(imageSources)
      .where(
        and(
          eq(imageSources.orgId, orgId),
          eq(imageSources.kind, "external"),
          eq(imageSources.name, "stock-full"),
        ),
      )
      .limit(1);

    let stockFullId: string;
    if (existingExternal[0]) {
      stockFullId = existingExternal[0].id;
      // Follow deploy pin changes: when VALET_FULL_BASE_IMAGE moves to a new
      // tag, the external row must move with it or every org keeps baking
      // its full base FROM the stale CI image. The ref change moves the full
      // base's identity, so the nightly scheduler rebakes it on the new pin.
      const currentRef = await this.db
        .select({ externalRef: imageSources.externalRef })
        .from(imageSources)
        .where(eq(imageSources.id, stockFullId))
        .limit(1);
      if (currentRef[0] && currentRef[0].externalRef !== fullBaseImage) {
        await this.db
          .update(imageSources)
          .set({ externalRef: fullBaseImage, updatedAt: now })
          .where(eq(imageSources.id, stockFullId));
        console.log(
          `seedDefaultBasesIfMissing(${orgId}): stock-full ref ${currentRef[0].externalRef} → ${fullBaseImage}`,
        );
      }
    } else {
      stockFullId = `src_${this.newId()}`;
      await this.db.insert(imageSources).values({
        id: stockFullId,
        orgId,
        kind: "external",
        parentId: null,
        name: "stock-full",
        externalRef: fullBaseImage,
        pullSecretName: null,
        setupCommands: null,
        profile: null,
        repoHost: null,
        repoFullName: null,
        cloneUrl: null,
        schedule: "nightly",
        enabled: true,
        lastBoundAt: null,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`seedDefaultBasesIfMissing(${orgId}): seeded stock-full external row ${stockFullId}`);
    }

    // Step 2 — retire the legacy headless base (single-lineage change):
    // nothing resolves it anymore, and an enabled row keeps burning a
    // nightly bake on a dead lineage.
    const retired = await this.db
      .update(imageSources)
      .set({ enabled: false, updatedAt: now })
      .where(
        and(
          eq(imageSources.orgId, orgId),
          eq(imageSources.kind, "base"),
          eq(imageSources.profile, "headless"),
          eq(imageSources.enabled, true),
        ),
      )
      .returning({ id: imageSources.id });
    if (retired.length > 0) {
      console.log(`seedDefaultBasesIfMissing(${orgId}): disabled legacy headless base ${retired[0]!.id}`);
    }

    // Step 3 — ensure the full base row exists.
    const existingFull = await this.db
      .select({ id: imageSources.id })
      .from(imageSources)
      .where(
        and(
          eq(imageSources.orgId, orgId),
          eq(imageSources.kind, "base"),
          eq(imageSources.profile, "full"),
        ),
      )
      .limit(1);

    if (!existingFull[0]) {
      const fullId = `src_${this.newId()}`;
      await this.db.insert(imageSources).values({
        id: fullId,
        orgId,
        kind: "base",
        parentId: stockFullId,
        name: "default-full",
        externalRef: null,
        pullSecretName: null,
        setupCommands: [],
        profile: "full",
        repoHost: null,
        repoFullName: null,
        cloneUrl: null,
        schedule: "nightly",
        enabled: true,
        lastBoundAt: null,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`seedDefaultBasesIfMissing(${orgId}): seeded full base ${fullId} FROM ${fullBaseImage}`);
      await this.maybeFireBaseBake(fullId, orgId);
    }
  }

  /** Best-effort background bake for a newly-seeded base source. Skips when
   * no builder is wired. Never throws. */
  private async maybeFireBaseBake(sourceId: string, orgId: string): Promise<void> {
    if (!this.builder) {
      console.log(`seedDefaultBasesIfMissing(${orgId}): no image builder — skipping first bake of ${sourceId}`);
      return;
    }
    if (await this.hasActiveBake(sourceId)) return;
    try {
      await this.startBake(sourceId);
    } catch (err) {
      console.error(`seedDefaultBasesIfMissing(${orgId}): first bake of ${sourceId} failed:`, err);
    }
  }

  /** Marks every `queued`/`building` row `failed` at boot (interrupted by
   * restart) and best-effort `cleanupOrphan`s durable cluster resources. */
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

  /** Runs the boot-time orphan sweep, then starts the poll (10s) and
   * scheduler (10min) intervals. Idempotent. */
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
