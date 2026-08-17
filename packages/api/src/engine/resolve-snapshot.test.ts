/**
 * `resolveSnapshot` unit tests (sandbox-reconciliation plan, Tasks 2 + 16).
 *
 * Covers:
 *   1. No prebuild rows: `repoBake` is null; `stockImage`/`apiUrl` pass
 *      through verbatim.
 *   2. A seeded pushed prebuild for the primary bound repo: `repoBake.imageRef`
 *      matches the prebuild row's `imageRef`.
 *   3. Base bake resolution: `baseBakeRef` reflects the org's kind='base'
 *      source's newest pushed bake; null when absent/disabled/queued/preflight
 *      fails.
 *
 * Uses real PGlite via `freshTestPgDb` (same pattern as
 * `packages/api/src/prebuilds/resolve.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxCapabilities, SandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { imageSources, bakes } from "../schema/index.js";
import type { SessionMeta } from "./host.js";
import type { RepoBinding } from "../wire/types.js";
import { resolveSnapshot } from "./resolve-snapshot.js";
import { computeSpec } from "./sandbox-spec.js";

const ORG = "org1";
const NOW = 1_700_000_000_000;
const REPO = "acme/widgets";
const STOCK_IMAGE = "ghcr.io/valet/sandbox:latest";
const API_URL = "http://localhost:8788";
const BASE_IMAGE_REF = "ghcr.io/valet/base-sandbox:v1";

function fakeProvider(customImage: boolean, backend = "fake"): SandboxProvider {
  const caps: SandboxCapabilities = {
    snapshot: "none",
    persistentWorkspace: true,
    tunnels: false,
    warmPool: false,
    hibernation: false,
    customImage,
  };
  return {
    backend,
    capabilities: () => caps,
    create: async () => {
      throw new Error("not used");
    },
    restore: async () => {
      throw new Error("not used");
    },
    destroy: async () => {},
    status: async (id) => ({ id, state: "released" }),
  };
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  const primary: RepoBinding & { targetDir: string } = {
    host: "github",
    fullName: REPO,
    cloneUrl: "https://github.com/acme/widgets.git",
    auth: "auto",
    targetDir: "widgets",
  };
  return {
    userId: "u1",
    orgId: ORG,
    workspace: "/tmp/w",
    repos: [primary],
    userName: "Test User",
    userEmail: "test@example.com",
    ...overrides,
  };
}

async function seedRepoBakeSource(db: AppDb): Promise<string> {
  const id = "cfg1";
  await db.insert(imageSources).values({
    id,
    orgId: ORG,
    kind: "repo",
    parentId: null,
    name: REPO,
    externalRef: null,
    pullSecretName: null,
    setupCommands: null,
    repoHost: "github",
    repoFullName: REPO,
    cloneUrl: "https://github.com/acme/widgets.git",
    schedule: "nightly",
    enabled: true,
    lastBoundAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function seedBaseSource(
  db: AppDb,
  opts: { enabled?: boolean; id?: string; profile?: "headless" | "full" } = {},
): Promise<string> {
  const id = opts.id ?? "base-src-1";
  await db.insert(imageSources).values({
    id,
    orgId: ORG,
    kind: "base",
    parentId: null,
    name: "org-base",
    externalRef: null,
    pullSecretName: null,
    setupCommands: null,
    // Profile-tagged base sources: default to headless so existing tests pass.
    profile: opts.profile ?? "headless",
    repoHost: null,
    repoFullName: null,
    cloneUrl: null,
    schedule: "nightly",
    enabled: opts.enabled ?? true,
    lastBoundAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function seedBake(
  db: AppDb,
  sourceId: string,
  opts: {
    id: string;
    status: "queued" | "building" | "pushed" | "failed";
    imageRef: string;
    createdAt?: number;
    commitSha?: string;
  },
): Promise<void> {
  await db.insert(bakes).values({
    id: opts.id,
    sourceId,
    identityHash: "",
    commitSha: opts.commitSha ?? null,
    imageRef: opts.imageRef,
    status: opts.status,
    builderBackend: "docker",
    recipe: { recipe: [], setup: [], image: undefined },
    error: null,
    logTail: null,
    startedAt: opts.createdAt ?? NOW,
    finishedAt: opts.createdAt ?? NOW,
    createdAt: opts.createdAt ?? NOW,
  });
}

async function seedPushedRepoBake(db: AppDb, sourceId: string): Promise<void> {
  await db.insert(bakes).values({
    id: "pb-1",
    sourceId,
    identityHash: "",
    commitSha: "abc123",
    imageRef: "valet-prebuild/acme-widgets:abc123",
    status: "pushed",
    builderBackend: "docker",
    recipe: { recipe: [{ id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" }], setup: [], image: undefined },
    error: null,
    logTail: null,
    startedAt: NOW,
    finishedAt: NOW,
    createdAt: NOW,
  });
}

describe("resolveSnapshot", () => {
  let harness: TestPgDb;
  let db: AppDb;

  beforeEach(async () => {
    harness = await freshTestPgDb();
    db = harness.appDb;
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it("no prebuild rows: repoBake is null; stockImage and apiUrl pass through verbatim", async () => {
    const snap = await resolveSnapshot({
      db,
      provider: fakeProvider(true),
      meta: meta(),
      apiUrl: API_URL,
      stockImage: STOCK_IMAGE,
    });

    expect(snap.repoBake).toBeNull();
    expect(snap.baseBakeRef).toBeNull();
    expect(snap.stockImage).toBe(STOCK_IMAGE);
    expect(snap.apiUrl).toBe(API_URL);
    expect(snap.userName).toBe("Test User");
    expect(snap.userEmail).toBe("test@example.com");
    // Single repo binds to "." (computeTargetDirs semantics)
    expect(snap.repos).toHaveLength(1);
    expect(snap.repos[0]?.targetDir).toBe("widgets");
    expect(snap.repos[0]?.fullName).toBe(REPO);
  });

  it("pushed prebuild for the primary bound repo: repoBake.imageRef matches", async () => {
    const cfg = await seedRepoBakeSource(db);
    await seedPushedRepoBake(db, cfg);

    const snap = await resolveSnapshot({
      db,
      provider: fakeProvider(true),
      meta: meta(),
      apiUrl: API_URL,
      stockImage: STOCK_IMAGE,
    });

    expect(snap.repoBake).not.toBeNull();
    expect(snap.repoBake?.imageRef).toBe("valet-prebuild/acme-widgets:abc123");
    expect(snap.repoBake?.bakedSha).toBe("abc123");
    expect(snap.repoBake?.bakeId).toBe("pb-1");
    expect(snap.repoBake?.recipe).toEqual([
      { id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
    ]);
    expect(snap.baseBakeRef).toBeNull();
    expect(snap.stockImage).toBe(STOCK_IMAGE);
    expect(snap.apiUrl).toBe(API_URL);
  });

  it("no db: repoBake is null, snapshot still fully populated", async () => {
    const snap = await resolveSnapshot({
      provider: fakeProvider(true),
      meta: meta(),
      apiUrl: API_URL,
      stockImage: STOCK_IMAGE,
    });

    expect(snap.repoBake).toBeNull();
    expect(snap.baseBakeRef).toBeNull();
    expect(snap.stockImage).toBe(STOCK_IMAGE);
    expect(snap.repos).toHaveLength(1);
  });

  it("no repos: snapshot has empty repos array", async () => {
    const snap = await resolveSnapshot({
      db,
      provider: fakeProvider(true),
      meta: meta({ repos: undefined }),
      apiUrl: API_URL,
      stockImage: STOCK_IMAGE,
    });

    expect(snap.repos).toEqual([]);
    expect(snap.repoBake).toBeNull();
  });

  it("multiple repos: targetDirs from meta (non-colliding → plain names supplied by caller)", async () => {
    const m = meta({
      repos: [
        { host: "github", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", auth: "auto", targetDir: "api" },
        { host: "github", fullName: "acme/web", cloneUrl: "https://github.com/acme/web.git", auth: "auto", targetDir: "web" },
      ],
    });
    const snap = await resolveSnapshot({
      db,
      provider: fakeProvider(true),
      meta: m,
      apiUrl: API_URL,
      stockImage: STOCK_IMAGE,
    });

    expect(snap.repos).toHaveLength(2);
    expect(snap.repos[0]?.targetDir).toBe("api");
    expect(snap.repos[1]?.targetDir).toBe("web");
  });

  // ── baseBakeRef (Task 16) ──────────────────────────────────────────────────

  describe("baseBakeRef", () => {
    it("unbound session + org base source with pushed bake → baseBakeRef = its imageRef", async () => {
      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, { id: "base-bake-1", status: "pushed", imageRef: BASE_IMAGE_REF });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined }), // unbound session
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.baseBakeRef).toBe(BASE_IMAGE_REF);
      expect(snap.repoBake).toBeNull();
    });

    it("repo session, no repo bake, base present → baseBakeRef set; computeSpec picks base image", async () => {
      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, { id: "base-bake-1", status: "pushed", imageRef: BASE_IMAGE_REF });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta(), // repo session, no repo bake seeded
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.repoBake).toBeNull();
      expect(snap.baseBakeRef).toBe(BASE_IMAGE_REF);
      // computeSpec should pick baseBakeRef as the image (repo bake null, base present)
      expect(computeSpec(snap).image).toBe(BASE_IMAGE_REF);
    });

    it("repo bake AND base present → computeSpec image = repo bake ref (chain order pin)", async () => {
      const repoCfg = await seedRepoBakeSource(db);
      await seedPushedRepoBake(db, repoCfg);

      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, { id: "base-bake-1", status: "pushed", imageRef: BASE_IMAGE_REF });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta(),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.repoBake?.imageRef).toBe("valet-prebuild/acme-widgets:abc123");
      expect(snap.baseBakeRef).toBe(BASE_IMAGE_REF);
      // repo bake takes priority over base bake
      expect(computeSpec(snap).image).toBe("valet-prebuild/acme-widgets:abc123");
    });

    it("base source with only queued/failed bakes → baseBakeRef null", async () => {
      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, { id: "base-queued", status: "queued", imageRef: "ignored:queued" });
      await seedBake(db, baseId, { id: "base-failed", status: "failed", imageRef: "ignored:failed", createdAt: NOW + 1 });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined }),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.baseBakeRef).toBeNull();
    });

    it("disabled base source → baseBakeRef null", async () => {
      const baseId = await seedBaseSource(db, { enabled: false });
      await seedBake(db, baseId, { id: "base-bake-1", status: "pushed", imageRef: BASE_IMAGE_REF });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined }),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.baseBakeRef).toBeNull();
    });

    it("preflight failure (registry down) → baseBakeRef null", async () => {
      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, {
        id: "base-bake-k8s",
        status: "pushed",
        imageRef: "localhost:30500/valet/base-sandbox:v1",
      });

      const fetchImpl: typeof fetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true, "kubernetes"),
        meta: meta({ repos: undefined }),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
        preflight: { registryInsecure: true, registryPushHost: "valet-registry:5000", fetchImpl },
      });

      expect(snap.baseBakeRef).toBeNull();
    });

    it("newest pushed base bake wins over older pushed bake", async () => {
      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, { id: "base-old", status: "pushed", imageRef: "ghcr.io/valet/base:old", createdAt: NOW });
      await seedBake(db, baseId, { id: "base-new", status: "pushed", imageRef: "ghcr.io/valet/base:new", createdAt: NOW + 1000 });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined }),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.baseBakeRef).toBe("ghcr.io/valet/base:new");
    });

    it("capability-false provider: baseBakeRef null even with pushed base bake", async () => {
      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, { id: "base-bake-1", status: "pushed", imageRef: BASE_IMAGE_REF });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(false), // customImage = false
        meta: meta({ repos: undefined }),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.baseBakeRef).toBeNull();
    });

    // ── profile-aware base selection ─────────────────────────────────────────

    it("headless session resolves headless base, ignores full base", async () => {
      const headlessId = await seedBaseSource(db, { id: "base-headless", profile: "headless" });
      const fullId = await seedBaseSource(db, { id: "base-full", profile: "full" });
      await seedBake(db, headlessId, { id: "bake-headless", status: "pushed", imageRef: "ghcr.io/valet/base:headless" });
      await seedBake(db, fullId, { id: "bake-full", status: "pushed", imageRef: "ghcr.io/valet/base:full" });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined, profile: "headless" }),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.baseBakeRef).toBe("ghcr.io/valet/base:headless");
    });

    it("full session resolves full base, ignores headless base", async () => {
      const headlessId = await seedBaseSource(db, { id: "base-headless", profile: "headless" });
      const fullId = await seedBaseSource(db, { id: "base-full", profile: "full" });
      await seedBake(db, headlessId, { id: "bake-headless", status: "pushed", imageRef: "ghcr.io/valet/base:headless" });
      await seedBake(db, fullId, { id: "bake-full", status: "pushed", imageRef: "ghcr.io/valet/base:full" });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined, profile: "full" }),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.baseBakeRef).toBe("ghcr.io/valet/base:full");
    });

    it("session with no profile defaults to headless base", async () => {
      const headlessId = await seedBaseSource(db, { id: "base-headless", profile: "headless" });
      const fullId = await seedBaseSource(db, { id: "base-full", profile: "full" });
      await seedBake(db, headlessId, { id: "bake-headless", status: "pushed", imageRef: "ghcr.io/valet/base:headless" });
      await seedBake(db, fullId, { id: "bake-full", status: "pushed", imageRef: "ghcr.io/valet/base:full" });

      // meta with no profile → should resolve headless
      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined, profile: undefined }),
        apiUrl: API_URL,
        stockImage: STOCK_IMAGE,
      });

      expect(snap.baseBakeRef).toBe("ghcr.io/valet/base:headless");
    });

    // ── boot-window stock-image fallthrough (per-profile defaultImages fix) ──
    //
    // These tests verify that when no base bake has been pushed yet (the
    // "boot window" after a fresh cluster deploy), `resolveSnapshot` faithfully
    // returns the caller-supplied `stockImage` — which `buildSpecProvider` now
    // sets to `defaultImages?.[profile] ?? defaultImage ?? ""`, making the
    // full-profile fall-through land on the full stock image instead of the
    // headless one. The `stockImage` field is a single string at this layer;
    // the per-profile selection lives in `buildSpecProvider` (host.ts).

    it("full-profile boot window: stockImage=full-stock → computeSpec image = full-stock (no base bake)", async () => {
      // No base sources seeded — boot-window state.
      const FULL_STOCK = "ghcr.io/tkhq/valet-sandbox:latest";

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined, profile: "full" }),
        apiUrl: API_URL,
        stockImage: FULL_STOCK,
      });

      expect(snap.baseBakeRef).toBeNull();
      expect(snap.stockImage).toBe(FULL_STOCK);

      const spec = computeSpec(snap);
      // No repoBake, no baseBakeRef → falls through to stockImage.
      expect(spec.image).toBe(FULL_STOCK);
    });

    it("headless-profile boot window: stockImage=headless-stock → computeSpec image = headless-stock (no base bake)", async () => {
      const HEADLESS_STOCK = "ghcr.io/tkhq/valet-sandbox-headless:latest";

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined, profile: "headless" }),
        apiUrl: API_URL,
        stockImage: HEADLESS_STOCK,
      });

      expect(snap.baseBakeRef).toBeNull();
      expect(snap.stockImage).toBe(HEADLESS_STOCK);

      const spec = computeSpec(snap);
      expect(spec.image).toBe(HEADLESS_STOCK);
    });

    it("full-profile with base bake pushed → uses bake ref, not stockImage", async () => {
      const FULL_STOCK = "ghcr.io/tkhq/valet-sandbox:latest";
      const BAKED = "ghcr.io/tkhq/valet-sandbox:baked-sha";
      const fullId = await seedBaseSource(db, { id: "base-full-bw", profile: "full" });
      await seedBake(db, fullId, { id: "bake-full-bw", status: "pushed", imageRef: BAKED });

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined, profile: "full" }),
        apiUrl: API_URL,
        stockImage: FULL_STOCK,
      });

      expect(snap.baseBakeRef).toBe(BAKED);
      const spec = computeSpec(snap);
      // Base bake ref wins over stockImage.
      expect(spec.image).toBe(BAKED);
    });

    it("no defaultImages set (stockImage=defaultImage fallback) → backwards compat", async () => {
      // Simulates a deploy where only VALET_SANDBOX_IMAGE is set (no per-profile
      // override) — stockImage == defaultImage for both profiles.
      const DEFAULT_IMAGE = "node:22-bookworm-slim";

      const snap = await resolveSnapshot({
        db,
        provider: fakeProvider(true),
        meta: meta({ repos: undefined, profile: "full" }),
        apiUrl: API_URL,
        stockImage: DEFAULT_IMAGE, // no defaultImages → caller passes defaultImage for both
      });

      expect(snap.baseBakeRef).toBeNull();
      const spec = computeSpec(snap);
      expect(spec.image).toBe(DEFAULT_IMAGE);
    });
  });
});
