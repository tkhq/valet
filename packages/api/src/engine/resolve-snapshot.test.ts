/**
 * `resolveSnapshot` unit tests (sandbox-reconciliation plan, Task 2).
 *
 * Covers the two key branches:
 *   1. No prebuild rows: `repoBake` is null; `stockImage`/`apiUrl` pass
 *      through verbatim.
 *   2. A seeded pushed prebuild for the primary bound repo: `repoBake.imageRef`
 *      matches the prebuild row's `imageRef`.
 *
 * Uses real PGlite via `freshTestPgDb` (same pattern as
 * `packages/api/src/prebuilds/resolve.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxCapabilities, SandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { prebuildConfigs, prebuilds } from "../schema/index.js";
import type { SessionMeta } from "./host.js";
import type { RepoBinding } from "../wire/types.js";
import { resolveSnapshot } from "./resolve-snapshot.js";

const ORG = "org1";
const NOW = 1_700_000_000_000;
const REPO = "acme/widgets";
const STOCK_IMAGE = "ghcr.io/valet/sandbox:latest";
const API_URL = "http://localhost:8788";

function fakeProvider(customImage: boolean): SandboxProvider {
  const caps: SandboxCapabilities = {
    snapshot: "none",
    persistentWorkspace: true,
    tunnels: false,
    warmPool: false,
    hibernation: false,
    customImage,
  };
  return {
    backend: "fake",
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
  const primary: RepoBinding = {
    host: "github",
    fullName: REPO,
    cloneUrl: "https://github.com/acme/widgets.git",
    auth: "auto",
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

async function seedConfig(db: AppDb): Promise<string> {
  const id = "cfg1";
  await db.insert(prebuildConfigs).values({
    id,
    orgId: ORG,
    repoHost: "github",
    repoFullName: REPO,
    cloneUrl: "https://github.com/acme/widgets.git",
    schedule: "nightly",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function seedPushedPrebuild(db: AppDb, configId: string): Promise<void> {
  await db.insert(prebuilds).values({
    id: "pb-1",
    configId,
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
    expect(snap.repos[0]?.targetDir).toBe(".");
    expect(snap.repos[0]?.fullName).toBe(REPO);
  });

  it("pushed prebuild for the primary bound repo: repoBake.imageRef matches", async () => {
    const cfg = await seedConfig(db);
    await seedPushedPrebuild(db, cfg);

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

  it("multiple repos: targetDirs computed per computeTargetDirs (non-colliding → plain names)", async () => {
    const m = meta({
      repos: [
        { host: "github", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", auth: "auto" },
        { host: "github", fullName: "acme/web", cloneUrl: "https://github.com/acme/web.git", auth: "auto" },
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
});
