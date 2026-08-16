/**
 * `/api/org/sources` — org-admin CRUD for all image sources + bake lifecycle.
 * Replaces prebuilds.test.ts and image-catalog.test.ts.
 *
 * Auth gates: admin CRUD on /api/org/sources, member badge on
 * /api/sources/for-repo. All original prebuilds + image-catalog pins are
 * preserved; new tests cover: base one-per-org 409, kind='repo' POST 400,
 * newline setup command 400, PATCH kind-scoped field 400s.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import type { BuildStatus, ImageBuilder, PrebuildSpec } from "../prebuilds/builder.js";
import { bakes } from "../schema/index.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

interface SourceJson {
  id: string;
  orgId: string;
  kind: string;
  parentId: string | null;
  name: string;
  externalRef: string | null;
  pullSecretName: string | null;
  setupCommands: string[] | null;
  profile: string | null;
  repoHost: string | null;
  repoFullName: string | null;
  cloneUrl: string | null;
  schedule: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createExternal(baseUrl: string, overrides: Record<string, unknown> = {}): Promise<SourceJson> {
  const res = await fetch(`${baseUrl}/api/org/sources`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ kind: "external", name: "Base Image", externalRef: "ghcr.io/acme/base:latest", ...overrides }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { source: SourceJson };
  return body.source;
}

async function createBase(baseUrl: string, overrides: Record<string, unknown> = {}): Promise<SourceJson> {
  const res = await fetch(`${baseUrl}/api/org/sources`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ kind: "base", name: "Org Base", setupCommands: [], profile: "headless", ...overrides }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { source: SourceJson };
  return body.source;
}

// Insert a repo-kind source directly (since POST rejects kind='repo').
async function seedRepoSource(apiInstance: TestApi): Promise<SourceJson> {
  const { db } = apiInstance.providers;
  // Use the schema table directly via Drizzle
  const { imageSources } = await import("../schema/index.js");
  const now = Date.now();
  const row = {
    id: `src_${randomUUID()}`,
    orgId: "local-org",
    kind: "repo" as const,
    parentId: null,
    name: "acme/widgets",
    externalRef: null,
    pullSecretName: null,
    setupCommands: null,
    // profile is null for kind='repo' sources.
    profile: null,
    repoHost: "github",
    repoFullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    schedule: "nightly" as const,
    enabled: true,
    lastBoundAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(imageSources).values(row);
  // SourceJson is the wire shape: the row minus the DB-only lastBoundAt.
  const { lastBoundAt: _lastBoundAt, ...source } = row;
  return source;
}

// ── GET /api/org/sources ──────────────────────────────────────────────────────

describe("GET /api/org/sources", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("returns empty list + builderAvailable: false when no builder wired", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: SourceJson[]; builderAvailable: boolean };
    expect(body.sources).toEqual([]);
    expect(body.builderAvailable).toBe(false);
  });

  it("reports builderAvailable: true when a builder is wired", async () => {
    api = await bootTestApi({ imageBuilder: new FakeImageBuilder() });
    const res = await fetch(`${api.baseUrl}/api/org/sources`, { headers: HEADERS });
    const body = (await res.json()) as { sources: SourceJson[]; builderAvailable: boolean };
    expect(body.builderAvailable).toBe(true);
  });

  it("lists all kinds for the caller's org", async () => {
    api = await bootTestApi();
    await createExternal(api.baseUrl);
    await createBase(api.baseUrl);
    await seedRepoSource(api);
    const res = await fetch(`${api.baseUrl}/api/org/sources`, { headers: HEADERS });
    const body = (await res.json()) as { sources: SourceJson[] };
    expect(body.sources).toHaveLength(3);
    const kinds = body.sources.map((s) => s.kind).sort();
    expect(kinds).toEqual(["base", "external", "repo"]);
  });
});

// ── POST /api/org/sources — kind='external' ───────────────────────────────────

describe("POST /api/org/sources (kind=external)", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ kind: "external", name: "Base", externalRef: "ghcr.io/acme/base:latest" }),
    });
    expect(res.status).toBe(403);
  });

  it("400s when externalRef is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "external", name: "Base" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when name is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "external", externalRef: "ghcr.io/acme/base:latest" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an external source with optional pullSecretName", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind: "external",
        name: "K8s base",
        externalRef: "registry.internal/base:latest",
        pullSecretName: "regcred",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source: SourceJson };
    expect(body.source.kind).toBe("external");
    expect(body.source.pullSecretName).toBe("regcred");
    expect(body.source.externalRef).toBe("registry.internal/base:latest");
    expect(typeof body.source.id).toBe("string");
  });

  it("profile field is not accepted for kind='external' (not stored)", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind: "external",
        name: "Ext with profile",
        externalRef: "ghcr.io/acme/base:latest",
        profile: "headless",
      }),
    });
    // External sources succeed even if profile is passed — it's silently ignored.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source: SourceJson };
    // profile must be null for external sources.
    expect(body.source.profile).toBeNull();
  });
});

// ── POST /api/org/sources — kind='base' ───────────────────────────────────────

describe("POST /api/org/sources (kind=base)", () => {
  it("creates a base source", async () => {
    api = await bootTestApi();
    const source = await createBase(api.baseUrl);
    expect(source.kind).toBe("base");
    expect(source.setupCommands).toEqual([]);
    expect(source.enabled).toBe(true);
  });

  it("409s on a second base source for the same (org, profile)", async () => {
    api = await bootTestApi();
    await createBase(api.baseUrl, { profile: "headless" });
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "base", name: "Second Base", profile: "headless" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already exists for this org and profile");
  });

  it("allows two base sources for different profiles", async () => {
    api = await bootTestApi();
    await createBase(api.baseUrl, { profile: "headless" });
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "base", name: "Full Base", profile: "full" }),
    });
    expect(res.status).toBe(201);
  });

  it("400s when profile is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "base", name: "Base", setupCommands: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("profile");
  });

  it("400s when profile is an invalid string", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "base", name: "Base", profile: "agent", setupCommands: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("profile");
  });

  it("400s when a setup command contains a newline", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "base", name: "Base", profile: "headless", setupCommands: ["apt-get install\ngit"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("single lines");
  });

  it("400s when a setup command contains a carriage return", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "base", name: "Base", profile: "headless", setupCommands: ["apt-get install\rgit"] }),
    });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/org/sources — kind='repo' rejection ────────────────────────────

describe("POST /api/org/sources (kind=repo)", () => {
  it("400s with an explanation that repo sources are auto-created", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "repo", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("automatically");
  });
});

// ── PATCH /api/org/sources/:id ────────────────────────────────────────────────

describe("PATCH /api/org/sources/:id", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const source = await createExternal(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
  });

  it("404s for a nonexistent id", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources/nonexistent`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCHes enabled and schedule on any kind", async () => {
    api = await bootTestApi();
    const source = await createExternal(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ schedule: "off", enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: SourceJson };
    expect(body.source.schedule).toBe("off");
    expect(body.source.enabled).toBe(false);
  });

  it("400s when schedule is invalid", async () => {
    api = await bootTestApi();
    const source = await createExternal(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ schedule: "weekly" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when setting setupCommands on a non-base source (kind-scoped field)", async () => {
    api = await bootTestApi();
    const source = await createExternal(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ setupCommands: ["apt-get install git"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("kind='base'");
  });

  it("400s when setting externalRef on a non-external source (kind-scoped field)", async () => {
    api = await bootTestApi();
    const source = await createBase(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ externalRef: "registry.io/new:latest" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("kind='external'");
  });

  it("400s when setting parentId on a non-repo source (kind-scoped field)", async () => {
    api = await bootTestApi();
    const source = await createExternal(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ parentId: "some-id" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("kind='repo'");
  });

  it("PATCHes setupCommands on a base source", async () => {
    api = await bootTestApi();
    const source = await createBase(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ setupCommands: ["apt-get update", "apt-get install -y git"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: SourceJson };
    expect(body.source.setupCommands).toEqual(["apt-get update", "apt-get install -y git"]);
  });

  it("400s when patching setupCommands with a newline in a command", async () => {
    api = await bootTestApi();
    const source = await createBase(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ setupCommands: ["apt-get update\napt-get install git"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("single lines");
  });

  it("PATCHes externalRef on an external source", async () => {
    api = await bootTestApi();
    const source = await createExternal(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ externalRef: "registry.io/updated:v2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: SourceJson };
    expect(body.source.externalRef).toBe("registry.io/updated:v2");
  });

  it("cross-kind isolation: external id 400s on patch attempting repo-kind field", async () => {
    api = await bootTestApi();
    // Create an external source, then try to use its id for a parentId patch
    // (which is repo-only) — 400 because external kind rejects parentId.
    const external = await createExternal(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${external.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ parentId: null }),
    });
    // parentId is repo-only — rejects with 400 regardless of id being valid
    expect(res.status).toBe(400);
  });

  it("400s when attempting to change profile (profile is immutable)", async () => {
    api = await bootTestApi();
    const source = await createBase(api.baseUrl, { profile: "headless" });
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ profile: "full" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("immutable");
  });
});

// ── DELETE /api/org/sources/:id ───────────────────────────────────────────────

describe("DELETE /api/org/sources/:id", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const source = await createExternal(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "DELETE",
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("404s for a nonexistent id", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources/nonexistent`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("deletes an external source", async () => {
    api = await bootTestApi();
    const source = await createExternal(api.baseUrl);
    const delRes = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(200);
    const listRes = await fetch(`${api.baseUrl}/api/org/sources`, { headers: HEADERS });
    const body = (await listRes.json()) as { sources: SourceJson[] };
    expect(body.sources).toHaveLength(0);
  });

  it("deletes a base source", async () => {
    api = await bootTestApi();
    const source = await createBase(api.baseUrl);
    const delRes = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(200);
  });

  it("deletes a repo source", async () => {
    api = await bootTestApi();
    const source = await seedRepoSource(api);
    const delRes = await fetch(`${api.baseUrl}/api/org/sources/${source.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(200);
  });
});

// ── POST /api/org/sources/:id/bake ───────────────────────────────────────────

describe("POST /api/org/sources/:id/bake", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const source = await seedRepoSource(api);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}/bake`, {
      method: "POST",
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("404s for a nonexistent source", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources/nonexistent/bake`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("409s when no builder is wired (PrebuildUnavailableError)", async () => {
    api = await bootTestApi();
    const source = await seedRepoSource(api);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}/bake`, {
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

    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", {
      type: "api_key",
      accessToken: "org-pat-token",
      metadata: { login: "org-pat" },
    });

    const source = await seedRepoSource(api);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}/bake`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { bake: { status: string; commitSha: string } };
    expect(body.bake.status).toBe("queued");
    expect(body.bake.commitSha).toBe("headsha1");
    expect(JSON.stringify(body)).not.toContain("org-pat-token");
    expect(builder.specs).toHaveLength(1);
  });
});

// ── GET /api/org/sources/:id/bakes ───────────────────────────────────────────

describe("GET /api/org/sources/:id/bakes", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const source = await seedRepoSource(api);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}/bakes`, {
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("404s for a nonexistent source", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/sources/nonexistent/bakes`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("returns an empty history for a fresh source", async () => {
    api = await bootTestApi();
    const source = await seedRepoSource(api);
    const res = await fetch(`${api.baseUrl}/api/org/sources/${source.id}/bakes`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bakes: unknown[] };
    expect(body.bakes).toEqual([]);
  });
});

// ── GET /api/sources/for-repo ─────────────────────────────────────────────────

describe("GET /api/sources/for-repo", () => {
  it("400s when fullName is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/sources/for-repo`, { headers: HEADERS });
    expect(res.status).toBe(400);
  });

  it("is reachable by a non-admin org member (no requireOrgAdmin gate)", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/sources/for-repo?fullName=acme/widgets`, {
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(200);
  });

  it("returns prebuild: null when no repo source exists for the fullName", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/sources/for-repo?fullName=acme/widgets`, { headers: HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prebuild: null });
  });

  it("returns prebuild: null when the source has no pushed bake", async () => {
    api = await bootTestApi();
    await seedRepoSource(api);
    const res = await fetch(`${api.baseUrl}/api/sources/for-repo?fullName=acme/widgets`, { headers: HEADERS });
    expect(await res.json()).toEqual({ prebuild: null });
  });

  it("returns the newest pushed bake's commitSha + finishedAt, and no other fields", async () => {
    api = await bootTestApi();
    const source = await seedRepoSource(api);
    const { db } = api.providers;
    await db.insert(bakes).values([
      {
        id: `pb_${randomUUID()}`,
        sourceId: source.id,
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
        sourceId: source.id,
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
        sourceId: source.id,
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

    const res = await fetch(`${api.baseUrl}/api/sources/for-repo?fullName=acme/widgets`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ prebuild: { commitSha: "newestc2", finishedAt: 4_000 } });
    expect(JSON.stringify(body)).not.toContain("imageRef");
    expect(JSON.stringify(body)).not.toContain("registry.local");
  });
});
