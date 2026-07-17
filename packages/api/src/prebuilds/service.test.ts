/**
 * `PrebuildService` lifecycle tests (sandbox images v2 plan, Task 3).
 * Exercises the full build lifecycle against a fake `ImageBuilder` and the
 * shared GitHub fixture's contents/commits/repo endpoints — never a real
 * docker daemon or GitHub API.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { startGithubFixture, type GithubFixture, type GithubFixtureResponse } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs, prebuildConfigs, prebuilds, imageCatalog } from "../schema/index.js";
import type { GitHubTokenDeps } from "../services/github-tokens.js";
import type { BuildStatus, ImageBuilder, PrebuildSpec } from "./builder.js";
import { PrebuildService, PrebuildUnavailableError, imageRefFor, slugify } from "./service.js";

const orgId = "org1";
const NOW = 1_700_000_000_000;

class FakeImageBuilder implements ImageBuilder {
  readonly backend = "docker";
  readonly specs: PrebuildSpec[] = [];
  readonly buildIds: string[] = [];
  private readonly states = new Map<string, BuildStatus>();
  private nextId = 1;

  async build(spec: PrebuildSpec): Promise<{ buildId: string }> {
    const buildId = `fake-build-${this.nextId++}`;
    this.specs.push(spec);
    this.buildIds.push(buildId);
    this.states.set(buildId, { state: "building" });
    return { buildId };
  }

  async status(buildId: string): Promise<BuildStatus> {
    const s = this.states.get(buildId);
    if (!s) throw new Error(`FakeImageBuilder: unknown buildId ${buildId}`);
    return s;
  }

  setState(buildId: string, status: BuildStatus): void {
    this.states.set(buildId, status);
  }
}

/** Fix round 1: exercises `startBuild`'s wrap-`builder.build()` path — a
 * rejecting builder must not strand the row at `queued`. */
class ThrowingImageBuilder implements ImageBuilder {
  readonly backend = "docker";

  async build(): Promise<{ buildId: string }> {
    throw new Error("boom: docker daemon unreachable");
  }

  async status(): Promise<BuildStatus> {
    throw new Error("ThrowingImageBuilder.status should never be called");
  }
}

function b64(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

async function seedOrg(db: AppDb, credentials: PgCredentialStore): Promise<void> {
  await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: NOW });
  // An org-owned PAT is the cheapest way to make `resolveGitHubToken`'s
  // `auto` tiers succeed for both "api" and "git" purposes without also
  // seeding a `github_app` config + installation row (see
  // `services/github-tokens.ts`'s "auto" precedence doc comment).
  await credentials.save({ type: "org", id: orgId }, "github", {
    type: "api_key",
    accessToken: "org-pat-token",
    metadata: { login: "org-pat" },
  });
}

async function seedConfig(
  db: AppDb,
  overrides: Partial<typeof prebuildConfigs.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? `pbc_${Math.random().toString(36).slice(2)}`;
  await db.insert(prebuildConfigs).values({
    id,
    orgId,
    repoHost: "github",
    repoFullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    baseImageId: null,
    schedule: "nightly",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return id;
}

describe("PrebuildService.startBuild / syncActiveBuilds", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;
  let fixture: GithubFixture;
  let builder: FakeImageBuilder;
  let retentionCalls: Array<{ backend: string; imageRefs: string[] }>;
  let service: PrebuildService;
  let currentSha = "headsha1";

  function contentsFor(path: string): GithubFixtureResponse {
    if (path === "package-lock.json") {
      return { body: { content: b64("{}"), encoding: "base64" } };
    }
    return { status: 404, body: { message: "Not Found" } };
  }

  function githubTokenDeps(): GitHubTokenDeps {
    return {
      db,
      credentials,
      key: deriveSecretKey("cache-key"),
      apiUrl: fixture.url,
      githubUrl: fixture.url,
      now: () => NOW,
    };
  }

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await seedOrg(db, credentials);

    currentSha = "headsha1";
    fixture = startGithubFixture({
      getRepo: () => ({ body: { default_branch: "main" } }),
      getCommit: () => ({ body: { sha: currentSha } }),
      getContents: (_owner, _repo, path) => contentsFor(path),
    });

    builder = new FakeImageBuilder();
    retentionCalls = [];
    service = new PrebuildService({
      db,
      builder,
      githubTokenDeps: githubTokenDeps(),
      now: () => NOW,
      retention: async (backend, imageRefs) => {
        retentionCalls.push({ backend, imageRefs });
      },
    });
  });

  afterEach(async () => {
    service.stop();
    await fixture.close();
  });

  describe("startBuild", () => {
    it("resolves the recipe via the GitHub contents API and dispatches a queued build", async () => {
      const configId = await seedConfig(db);
      const row = await service.startBuild(configId);

      expect(row.status).toBe("queued");
      expect(row.commitSha).toBe("headsha1");
      expect(row.builderBackend).toBe("docker");
      expect(row.imageRef).toBe(imageRefFor("docker", "acme", "widgets", "headsha1"));
      expect(row.recipe).toEqual({
        recipe: [{ id: "npm-ci", lockfile: "package-lock.json", command: "npm ci" }],
        setup: [],
        image: undefined,
      });

      expect(builder.specs).toHaveLength(1);
      const spec = builder.specs[0];
      expect(spec.commitSha).toBe("headsha1");
      expect(spec.cloneUrl).toBe("https://github.com/acme/widgets.git");
      expect(spec.gitToken).toBe("org-pat-token");
      expect(spec.recipe).toEqual([{ id: "npm-ci", lockfile: "package-lock.json", command: "npm ci" }]);

      // Persisted row never carries the git token.
      expect(JSON.stringify(row)).not.toContain("org-pat-token");
      const dbRows = await db.select().from(prebuilds);
      expect(dbRows).toHaveLength(1);
      expect(JSON.stringify(dbRows[0])).not.toContain("org-pat-token");
    });

    it("throws PrebuildUnavailableError when no builder is wired", async () => {
      const configId = await seedConfig(db);
      const noBuilderService = new PrebuildService({ db, builder: null, githubTokenDeps: githubTokenDeps() });
      await expect(noBuilderService.startBuild(configId)).rejects.toBeInstanceOf(PrebuildUnavailableError);
      expect(builder.specs).toHaveLength(0);
    });

    it("prefers the image_catalog base image when there is no .valet/prebuild.yaml override", async () => {
      await db.insert(imageCatalog).values({
        id: "img_1",
        orgId,
        name: "Custom base",
        ref: "ghcr.io/acme/base:latest",
        pullSecretName: null,
        kind: "base",
        createdAt: NOW,
      });
      const configId = await seedConfig(db, { baseImageId: "img_1" });
      await service.startBuild(configId);
      expect(builder.specs[0].baseImage).toBe("ghcr.io/acme/base:latest");
    });

    it("falls back to the default base image when neither an override nor a catalog pin resolve one", async () => {
      const configId = await seedConfig(db);
      await service.startBuild(configId);
      expect(builder.specs[0].baseImage).toBeTruthy();
    });

    it("falls back to VALET_SANDBOX_IMAGE (the stock sandbox image, spec decision 6) via the injected env, not the hardcoded node:20-bookworm", async () => {
      const configId = await seedConfig(db);
      const envService = new PrebuildService({
        db,
        builder,
        githubTokenDeps: githubTokenDeps(),
        now: () => NOW,
        env: { VALET_SANDBOX_IMAGE: "ghcr.io/valet/sandbox:stock" },
      });

      await envService.startBuild(configId);

      expect(builder.specs[0].baseImage).toBe("ghcr.io/valet/sandbox:stock");
    });

    it("marks the row failed (not stuck at queued) when builder.build() rejects", async () => {
      const configId = await seedConfig(db);
      const throwingService = new PrebuildService({
        db,
        builder: new ThrowingImageBuilder(),
        githubTokenDeps: githubTokenDeps(),
        now: () => NOW,
      });

      await expect(throwingService.startBuild(configId)).rejects.toThrow(/boom: docker daemon unreachable/);

      const rows = await db.select().from(prebuilds).where(eq(prebuilds.configId, configId));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].error).toContain("boom: docker daemon unreachable");
      expect(rows[0].finishedAt).toBe(NOW);
    });
  });

  describe("syncActiveBuilds", () => {
    it("transitions a build to pushed and stamps finishedAt", async () => {
      const configId = await seedConfig(db);
      const row = await service.startBuild(configId);
      builder.setState(builder.buildIds[0], { state: "pushed", logTail: "done" });

      await service.syncActiveBuilds();

      const [updated] = await db.select().from(prebuilds).where(eq(prebuilds.id, row.id));
      expect(updated.status).toBe("pushed");
      expect(updated.finishedAt).toBe(NOW);
      expect(updated.logTail).toBe("done");
    });

    it("transitions a build to failed and records the error", async () => {
      const configId = await seedConfig(db);
      const row = await service.startBuild(configId);
      builder.setState(builder.buildIds[0], { state: "failed", error: "docker build exited with code 1" });

      await service.syncActiveBuilds();

      const [updated] = await db.select().from(prebuilds).where(eq(prebuilds.id, row.id));
      expect(updated.status).toBe("failed");
      expect(updated.error).toBe("docker build exited with code 1");
      expect(updated.finishedAt).toBe(NOW);
    });

    it("leaves a still-building row untouched aside from logTail", async () => {
      const configId = await seedConfig(db);
      const row = await service.startBuild(configId);
      builder.setState(builder.buildIds[0], { state: "building", logTail: "still going" });

      await service.syncActiveBuilds();

      const [updated] = await db.select().from(prebuilds).where(eq(prebuilds.id, row.id));
      expect(updated.status).toBe("building");
      expect(updated.finishedAt).toBeNull();
    });

    it("retains exactly the newest 2 pushed builds per config, pruning the rest via the retention seam", async () => {
      const configId = await seedConfig(db);
      const shas = ["sha-a", "sha-b", "sha-c"];
      const imageRefs: string[] = [];
      // Step the clock per build — `createdAt` ties under a fixed clock make
      // `applyRetention`'s `ORDER BY createdAt DESC` (which decides "newest
      // 2") ambiguous between rows, a latent flake source.
      let clock = NOW;
      const steppedService = new PrebuildService({
        db,
        builder,
        githubTokenDeps: githubTokenDeps(),
        now: () => clock,
        retention: async (backend, imgRefs) => {
          retentionCalls.push({ backend, imageRefs: imgRefs });
        },
      });

      for (const sha of shas) {
        currentSha = sha;
        clock += 1000;
        const row = await steppedService.startBuild(configId);
        imageRefs.push(row.imageRef);
        builder.setState(builder.buildIds[builder.buildIds.length - 1], { state: "pushed" });
        await steppedService.syncActiveBuilds();
      }

      expect(retentionCalls).toHaveLength(1);
      expect(retentionCalls[0].backend).toBe("docker");
      expect(retentionCalls[0].imageRefs).toEqual([imageRefs[0]]);

      // Rows are history — never deleted, only the images are pruned.
      const rows = await db.select().from(prebuilds).where(eq(prebuilds.configId, configId));
      expect(rows.filter((r) => r.status === "pushed")).toHaveLength(3);
    });

    it("does not delete an image still referenced by a kept row when a repeated-sha rebuild shares its imageRef", async () => {
      const configId = await seedConfig(db);
      let clock = NOW;
      const steppedService = new PrebuildService({
        db,
        builder,
        githubTokenDeps: githubTokenDeps(),
        now: () => clock,
        retention: async (backend, imgRefs) => {
          retentionCalls.push({ backend, imageRefs: imgRefs });
        },
      });

      async function pushBuild(sha: string) {
        currentSha = sha;
        clock += 1000;
        const row = await steppedService.startBuild(configId);
        builder.setState(builder.buildIds[builder.buildIds.length - 1], { state: "pushed" });
        await steppedService.syncActiveBuilds();
        return row;
      }

      const rowA = await pushBuild("sha-a");
      const rowB = await pushBuild("sha-b");
      // Rebuild the SAME sha as rowA — `imageRefFor` is keyed on sha, so
      // this produces a row whose imageRef equals rowA's, even though it's
      // a distinct `prebuilds` row.
      const rowA2 = await pushBuild("sha-a");
      expect(rowA2.imageRef).toBe(rowA.imageRef);

      // Kept-by-recency: rowA2 and rowB. Stale: rowA — but its imageRef is
      // still referenced by kept rowA2, so nothing should be deleted.
      expect(retentionCalls).toHaveLength(0);

      const rows = await db.select().from(prebuilds).where(eq(prebuilds.configId, configId));
      expect(rows.filter((r) => r.status === "pushed")).toHaveLength(3);
    });
  });

  describe("start()", () => {
    it("sweeps queued/building rows to failed (interrupted by restart) before starting the poll/scheduler intervals", async () => {
      const configId = await seedConfig(db);
      await db.insert(prebuilds).values({
        id: "pb_stuck_building",
        configId,
        commitSha: "stuckbuilding",
        imageRef: "valet-prebuild/acme-widgets:stuckbuilding",
        status: "building",
        builderBackend: "docker",
        recipe: { recipe: [], setup: [] },
        error: null,
        logTail: null,
        startedAt: NOW,
        finishedAt: null,
        createdAt: NOW,
      });
      await db.insert(prebuilds).values({
        id: "pb_stuck_queued",
        configId,
        commitSha: "stuckqueued",
        imageRef: "valet-prebuild/acme-widgets:stuckqueued",
        status: "queued",
        builderBackend: "docker",
        recipe: { recipe: [], setup: [] },
        error: null,
        logTail: null,
        startedAt: NOW,
        finishedAt: null,
        createdAt: NOW,
      });
      // A pushed row from a prior process must be left alone by the sweep.
      await db.insert(prebuilds).values({
        id: "pb_already_pushed",
        configId,
        commitSha: "donesha",
        imageRef: "valet-prebuild/acme-widgets:donesha",
        status: "pushed",
        builderBackend: "docker",
        recipe: { recipe: [], setup: [] },
        error: null,
        logTail: null,
        startedAt: NOW,
        finishedAt: NOW,
        createdAt: NOW,
      });

      await service.start();

      const rows = await db.select().from(prebuilds).where(eq(prebuilds.configId, configId));
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get("pb_stuck_building")?.status).toBe("failed");
      expect(byId.get("pb_stuck_building")?.error).toBe("interrupted by restart");
      expect(byId.get("pb_stuck_queued")?.status).toBe("failed");
      expect(byId.get("pb_stuck_queued")?.error).toBe("interrupted by restart");
      expect(byId.get("pb_already_pushed")?.status).toBe("pushed");
      expect(byId.get("pb_already_pushed")?.error).toBeNull();
    });
  });
});

describe("PrebuildService.runSchedulerPass", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;
  let fixture: GithubFixture;
  let builder: FakeImageBuilder;
  let service: PrebuildService;

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await seedOrg(db, credentials);

    fixture = startGithubFixture({
      getRepo: () => ({ body: { default_branch: "main" } }),
      getCommit: () => ({ body: { sha: "current-head" } }),
      getContents: () => ({ status: 404, body: { message: "Not Found" } }),
    });
    builder = new FakeImageBuilder();
    service = new PrebuildService({
      db,
      builder,
      githubTokenDeps: {
        db,
        credentials,
        key: deriveSecretKey("cache-key"),
        apiUrl: fixture.url,
        githubUrl: fixture.url,
        now: () => NOW,
      },
      now: () => NOW,
    });
  });

  afterEach(async () => {
    service.stop();
    await fixture.close();
  });

  async function seedBuild(configId: string, overrides: Partial<typeof prebuilds.$inferInsert> = {}): Promise<void> {
    await db.insert(prebuilds).values({
      id: overrides.id ?? `pb_${Math.random().toString(36).slice(2)}`,
      configId,
      commitSha: "stale-sha",
      imageRef: "valet-prebuild/acme-widgets:stale-sha",
      status: "pushed",
      builderBackend: "docker",
      recipe: { recipe: [], setup: [] },
      error: null,
      logTail: null,
      startedAt: NOW - 48 * 60 * 60 * 1000,
      finishedAt: NOW - 48 * 60 * 60 * 1000,
      createdAt: NOW - 48 * 60 * 60 * 1000,
      ...overrides,
    });
  }

  it("starts a rebuild when the newest build is stale and the head sha has drifted", async () => {
    const configId = await seedConfig(db);
    await seedBuild(configId);

    await service.runSchedulerPass();

    expect(builder.specs).toHaveLength(1);
    expect(builder.specs[0].commitSha).toBe("current-head");
  });

  it("skips a config whose newest build is fresh (<24h)", async () => {
    const configId = await seedConfig(db);
    await seedBuild(configId, {
      startedAt: NOW - 60 * 60 * 1000,
      finishedAt: NOW - 60 * 60 * 1000,
      createdAt: NOW - 60 * 60 * 1000,
    });

    await service.runSchedulerPass();
    expect(builder.specs).toHaveLength(0);
  });

  it("skips a config whose head sha matches the newest pushed build's sha", async () => {
    const configId = await seedConfig(db);
    await seedBuild(configId, { commitSha: "current-head", imageRef: "valet-prebuild/acme-widgets:current-head" });

    await service.runSchedulerPass();
    expect(builder.specs).toHaveLength(0);
  });

  it("skips a config with schedule: off", async () => {
    await seedConfig(db, { id: "pbc_off", schedule: "off" });
    await service.runSchedulerPass();
    expect(builder.specs).toHaveLength(0);
  });

  it("skips a disabled config", async () => {
    await seedConfig(db, { id: "pbc_disabled", enabled: false });
    await service.runSchedulerPass();
    expect(builder.specs).toHaveLength(0);
  });

  it("is a no-op when no builder is wired", async () => {
    await seedConfig(db);
    const noBuilderService = new PrebuildService({
      db,
      builder: null,
      githubTokenDeps: {
        db,
        credentials,
        key: deriveSecretKey("cache-key"),
        apiUrl: fixture.url,
        githubUrl: fixture.url,
        now: () => NOW,
      },
    });
    await expect(noBuilderService.runSchedulerPass()).resolves.toBeUndefined();
  });
});

describe("imageRefFor / slugify", () => {
  it("slugifies owner/repo into the valet-prebuild convention for docker", () => {
    expect(slugify("Acme_Corp")).toBe("acme-corp");
    expect(imageRefFor("docker", "Acme Corp", "My Repo!", "abc123")).toBe("valet-prebuild/acme-corp-my-repo:abc123");
  });
});
