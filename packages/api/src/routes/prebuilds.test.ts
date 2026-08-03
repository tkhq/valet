/**
 * `/api/org/prebuilds` — org-admin config CRUD + build lifecycle routes
 * (sandbox images v2 plan, Task 3). Same gating pattern as
 * `routes/image-catalog.test.ts`. `POST /configs/:id/rebuild` is exercised
 * against `bootTestApi`'s `imageBuilder` override (a fake `ImageBuilder`)
 * pointed at the shared GitHub fixture via `githubApiUrl`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import type { BuildStatus, ImageBuilder, PrebuildSpec } from "../prebuilds/builder.js";
import { bakes } from "../schema/index.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

interface PrebuildConfigJson {
  id: string;
  orgId: string;
  kind: string;
  parentId: string | null;
  name: string;
  repoHost: string | null;
  repoFullName: string | null;
  cloneUrl: string | null;
  schedule: string;
  enabled: boolean;
}

class FakeImageBuilder implements ImageBuilder {
  readonly backend = "docker";
  readonly specs: PrebuildSpec[] = [];
  private nextId = 1;

  async build(spec: PrebuildSpec): Promise<{ buildId: string }> {
    this.specs.push(spec);
    return { buildId: `fake-${this.nextId++}` };
  }

  async status(): Promise<BuildStatus> {
    return { state: "building" };
  }
}

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
});

async function createConfig(baseUrl: string, overrides: Partial<Record<string, unknown>> = {}): Promise<PrebuildConfigJson> {
  const res = await fetch(`${baseUrl}/api/org/prebuilds/configs`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      repoFullName: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { config: PrebuildConfigJson };
  return body.config;
}

describe("GET /api/org/prebuilds/meta", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/meta`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("reports builder: null when no builder is wired", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/meta`, { headers: HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ builder: null });
  });

  it("reports the wired backend id", async () => {
    api = await bootTestApi({ imageBuilder: new FakeImageBuilder() });
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/meta`, { headers: HEADERS });
    expect(await res.json()).toEqual({ builder: "docker" });
  });
});

describe("prebuild configs CRUD", () => {
  it("POST 403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" }),
    });
    expect(res.status).toBe(403);
  });

  it("400s when repoFullName is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ cloneUrl: "https://github.com/acme/widgets.git" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a config defaulting to schedule: nightly, enabled: true", async () => {
    api = await bootTestApi();
    const config = await createConfig(api.baseUrl);
    expect(config.schedule).toBe("nightly");
    expect(config.enabled).toBe(true);
    expect(config.repoHost).toBe("github");
  });

  it("409s creating a second config for the same repo", async () => {
    api = await bootTestApi();
    await createConfig(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" }),
    });
    expect(res.status).toBe(409);
  });

  it("lists configs for the caller's org", async () => {
    api = await bootTestApi();
    await createConfig(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs`, { headers: HEADERS });
    const body = (await res.json()) as { configs: PrebuildConfigJson[] };
    expect(body.configs).toHaveLength(1);
  });

  it("PATCHes schedule and enabled", async () => {
    api = await bootTestApi();
    const config = await createConfig(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/${config.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ schedule: "off", enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: PrebuildConfigJson };
    expect(body.config.schedule).toBe("off");
    expect(body.config.enabled).toBe(false);
  });

  it("PATCH 404s for a config outside the caller's org", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/nonexistent`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH 404s when id belongs to an external image-catalog entry, not a repo config", async () => {
    api = await bootTestApi();
    // Create an external-kind image via the image-catalog endpoint.
    const imgRes = await fetch(`${api.baseUrl}/api/org/image-catalog`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Base", ref: "ghcr.io/acme/base:latest" }),
    });
    expect(imgRes.status).toBe(201);
    const { image } = (await imgRes.json()) as { image: { id: string } };

    // Attempt to PATCH via the prebuilds/configs endpoint — must 404, not mutate.
    const patchRes = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/${image.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(404);
  });

  it("DELETEs a config", async () => {
    api = await bootTestApi();
    const config = await createConfig(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/${config.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(200);
    const listRes = await fetch(`${api.baseUrl}/api/org/prebuilds/configs`, { headers: HEADERS });
    const body = (await listRes.json()) as { configs: PrebuildConfigJson[] };
    expect(body.configs).toHaveLength(0);
  });
});

describe("POST /api/org/prebuilds/configs/:id/rebuild", () => {
  it("404s for a config outside the caller's org", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/nonexistent/rebuild`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("409s with 'unavailable on this deployment' when no builder is wired", async () => {
    api = await bootTestApi();
    const config = await createConfig(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/${config.id}/rebuild`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unavailable on this deployment");
  });

  it("202s and dispatches a build when a builder is wired", async () => {
    fixture = startGithubFixture({
      getRepo: () => ({ body: { default_branch: "main" } }),
      getCommit: () => ({ body: { sha: "headsha1" } }),
      getContents: () => ({ status: 404, body: { message: "Not Found" } }),
    });
    const builder = new FakeImageBuilder();
    api = await bootTestApi({ imageBuilder: builder, githubApiUrl: fixture.url });

    // Rebuild needs a healthy GitHub credential for the org — seed an
    // org-owned PAT directly (same minimal setup `prebuilds/service.test.ts`
    // uses), through the booted providers rather than a second boot.
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", {
      type: "api_key",
      accessToken: "org-pat-token",
      metadata: { login: "org-pat" },
    });

    const config = await createConfig(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/${config.id}/rebuild`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { prebuild: { status: string; commitSha: string } };
    expect(body.prebuild.status).toBe("queued");
    expect(body.prebuild.commitSha).toBe("headsha1");
    expect(JSON.stringify(body)).not.toContain("org-pat-token");
    expect(builder.specs).toHaveLength(1);
  });
});

describe("GET /api/org/prebuilds/configs/:id/builds", () => {
  it("404s for a config outside the caller's org", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/nonexistent/builds`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("returns an empty history for a fresh config", async () => {
    api = await bootTestApi();
    const config = await createConfig(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/prebuilds/configs/${config.id}/builds`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builds: unknown[] };
    expect(body.builds).toEqual([]);
  });
});

describe("GET /api/prebuilds/for-repo", () => {
  it("400s when fullName is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/prebuilds/for-repo`, { headers: HEADERS });
    expect(res.status).toBe(400);
  });

  it("is reachable by a non-admin org member (no requireOrgAdmin gate)", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/prebuilds/for-repo?fullName=acme/widgets`, {
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(200);
  });

  it("returns prebuild: null when no config exists for the repo", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/prebuilds/for-repo?fullName=acme/widgets`, { headers: HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prebuild: null });
  });

  it("returns prebuild: null when the config has no pushed build", async () => {
    api = await bootTestApi();
    await createConfig(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/prebuilds/for-repo?fullName=acme/widgets`, { headers: HEADERS });
    expect(await res.json()).toEqual({ prebuild: null });
  });

  it("returns the newest pushed build's commitSha + finishedAt, and no other fields", async () => {
    api = await bootTestApi();
    const config = await createConfig(api.baseUrl);
    const { db } = api.providers;
    await db.insert(bakes).values([
      {
        id: `pb_${randomUUID()}`,
        sourceId: config.id,
        identityHash: "",
        commitSha: "olderc1",
        imageRef: "registry.local/acme-widgets:olderc1",
        status: "pushed",
        builderBackend: "docker",
        recipe: [],
        startedAt: 1_000,
        finishedAt: 2_000,
        createdAt: 1_000,
      },
      {
        id: `pb_${randomUUID()}`,
        sourceId: config.id,
        identityHash: "",
        commitSha: "newestc2",
        imageRef: "registry.local/acme-widgets:newestc2",
        status: "pushed",
        builderBackend: "docker",
        recipe: [],
        startedAt: 3_000,
        finishedAt: 4_000,
        createdAt: 3_000,
      },
      {
        id: `pb_${randomUUID()}`,
        sourceId: config.id,
        identityHash: "",
        commitSha: "failedc3",
        imageRef: "registry.local/acme-widgets:failedc3",
        status: "failed",
        builderBackend: "docker",
        recipe: [],
        error: "boom",
        startedAt: 5_000,
        finishedAt: 6_000,
        createdAt: 5_000,
      },
    ]);

    const res = await fetch(`${api.baseUrl}/api/prebuilds/for-repo?fullName=acme/widgets`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ prebuild: { commitSha: "newestc2", finishedAt: 4_000 } });
    expect(JSON.stringify(body)).not.toContain("imageRef");
    expect(JSON.stringify(body)).not.toContain("registry.local");
  });
});
