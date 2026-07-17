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

      for (const sha of shas) {
        currentSha = sha;
        const row = await service.startBuild(configId);
        imageRefs.push(row.imageRef);
        builder.setState(builder.buildIds[builder.buildIds.length - 1], { state: "pushed" });
        await service.syncActiveBuilds();
      }

      expect(retentionCalls).toHaveLength(1);
      expect(retentionCalls[0].backend).toBe("docker");
      expect(retentionCalls[0].imageRefs).toEqual([imageRefs[0]]);

      // Rows are history — never deleted, only the images are pruned.
      const rows = await db.select().from(prebuilds).where(eq(prebuilds.configId, configId));
      expect(rows.filter((r) => r.status === "pushed")).toHaveLength(3);
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
