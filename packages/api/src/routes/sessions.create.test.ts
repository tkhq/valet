/**
 * POST /api/sessions — Task 5 (sandbox auth gateway plan): create accepts
 * an optional `profile` ("headless" | "full"), persists it, and returns it.
 * Omitting `profile` defaults to "headless".
 *
 * Also covers zero-config repo sources (sandbox-reconciliation plan, Task 19):
 * binding a repo at session-create time fires `ensureRepoSource` fire-and-forget,
 * upserts an enabled kind='repo' image_sources row, and queues a first bake when
 * an org GitHub credential and image builder are available.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture } from "../test-helpers/github-fixture.js";
import { agentSessions, sessionRepos, imageSources, bakes } from "../schema/index.js";
import type { BuildStatus, ImageBuilder, PrebuildSpec } from "../prebuilds/builder.js";
import type {
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  ListThreadsResponse,
} from "../wire/types.js";

// Minimal fake builder for zero-config source tests.
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

describe("POST /api/sessions: profile", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("defaults profile to 'headless' when omitted", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.profile).toBe("headless");

    const getRes = await fetch(`${api.baseUrl}/api/sessions/${body.id}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as GetSessionResponse;
    expect(getBody.profile).toBe("headless");
  });

  it("persists and returns profile: 'full' when requested", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-full-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, profile: "full" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.profile).toBe("full");

    const getRes = await fetch(`${api.baseUrl}/api/sessions/${body.id}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as GetSessionResponse;
    expect(getBody.profile).toBe("full");
  });

  it("rejects an invalid profile value", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-bad-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, profile: "bogus" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sessions: repo bindings", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("omits `repos` from the response when unbound (byte-identical to pre-repos behavior)", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-unbound-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    expect(body).not.toHaveProperty("repos");

    const getRes = await fetch(`${api.baseUrl}/api/sessions/${body.id}`);
    const getBody = (await getRes.json()) as GetSessionResponse;
    expect(getBody).not.toHaveProperty("repos");
  });

  it("accepts a single `repo` and returns it as a one-element list, persisted across GET", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-repo-sugar-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        repo: { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.repos).toEqual([
      {
        host: "github",
        fullName: "acme/widgets",
        cloneUrl: "https://github.com/acme/widgets.git",
        ref: undefined,
        auth: "auto",
      },
    ]);

    const getRes = await fetch(`${api.baseUrl}/api/sessions/${body.id}`);
    const getBody = (await getRes.json()) as GetSessionResponse;
    expect(getBody.repos).toEqual([
      {
        host: "github",
        fullName: "acme/widgets",
        cloneUrl: "https://github.com/acme/widgets.git",
        ref: undefined,
        auth: "auto",
      },
    ]);
  });

  it("accepts multiple `repos`, preserving position order and per-binding fields", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-repo-multi-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        repos: [
          { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", ref: "main" },
          { fullName: "acme/sprockets", cloneUrl: "https://github.com/acme/sprockets.git", auth: "app" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.repos?.map((r) => r.fullName)).toEqual(["acme/widgets", "acme/sprockets"]);
    expect(body.repos?.[0]?.ref).toBe("main");
    expect(body.repos?.[1]?.auth).toBe("app");
  });

  it("400s when both `repo` and `repos` are present", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-repo-conflict-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        repo: { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" },
        repos: [{ fullName: "acme/sprockets", cloneUrl: "https://github.com/acme/sprockets.git" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on a non-https cloneUrl", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-repo-http-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        repo: { fullName: "acme/widgets", cloneUrl: "git@github.com:acme/widgets.git" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on an empty fullName", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-repo-empty-name-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        repo: { fullName: "", cloneUrl: "https://github.com/acme/widgets.git" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when more than 5 repo bindings are provided", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-repo-toomany-"));

    const repos = Array.from({ length: 6 }, (_, i) => ({
      fullName: `acme/repo-${i}`,
      cloneUrl: `https://github.com/acme/repo-${i}.git`,
    }));
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, repos }),
    });
    expect(res.status).toBe(400);
  });

  it("rolls back the session row when the repo-bindings insert fails (atomicity)", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-repo-atomic-"));
    const { db } = api.providers;

    // `insert` is defined once on the shared `PgDatabase` prototype that
    // both the top-level `db` handle and any `tx` passed to
    // `db.transaction(...)` inherit from — patching it there lets us force
    // the *second* statement in the route's transaction (the
    // `sessionRepos` insert) to fail without touching the first
    // (`agentSessions`), regardless of which handle instance calls it.
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(db)) as {
      insert: (...args: unknown[]) => unknown;
    };
    const original = proto.insert;
    const spy = vi.spyOn(proto, "insert").mockImplementation(function (this: unknown, table: unknown) {
      if (table === sessionRepos) {
        throw new Error("simulated repo-bindings insert failure");
      }
      return original.apply(this, [table]);
    });

    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace,
          repo: { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" },
        }),
      });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    const rows = await db.select().from(agentSessions).where(eq(agentSessions.workspace, workspace));
    expect(rows).toHaveLength(0);
  });

  it("persists target_dir='widgets' on the session_repos row for a single-repo session (spec decision 15)", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-target-dir-"));
    const { db } = api.providers;

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        repo: { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;

    const rows = await db.select().from(sessionRepos).where(eq(sessionRepos.sessionId, body.id));
    expect(rows).toHaveLength(1);
    // Single-repo sessions now always clone into <repoName>/, not ".".
    expect(rows[0]?.targetDir).toBe("widgets");
  });

  it("400s on an invalid `auth` value", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-create-repo-badauth-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        repo: {
          fullName: "acme/widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
          auth: "bogus",
        },
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ── initialPrompt (wire `CreateSessionRequest`) ──────────────────────────────
//
// `initialPrompt` says "the server enqueues immediately after creation": the
// create handler runs the same `ensureDefaultThread()` + `submitPrompt()`
// sequence `POST /api/sessions/:id/messages` uses. No LLM key is needed to
// assert it — the submission is durable at admission, and with no
// ANTHROPIC_API_KEY the claim loop releases the turn back to `queued` instead
// of burning it on a keyless model call.

describe("POST /api/sessions: initialPrompt", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  /** Every submission of the session, settled or not — so the assertion does
   * not race a turn that a locally-configured API key let run to completion. */
  async function submissionsFor(testApi: TestApi, sessionId: string) {
    const { engineStore } = testApi.providers;
    const [unsettled, settled] = await Promise.all([
      engineStore.listUnsettledSubmissions(sessionId),
      engineStore.listSettledSubmissionsBefore(sessionId, Date.now() + 1),
    ]);
    return [...unsettled, ...settled];
  }

  it("queues the prompt on the new session's default thread", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-initial-prompt-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, initialPrompt: "List the files in this repo" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;

    const submissions = await submissionsFor(api, body.id);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.content).toBe("List the files in this repo");

    // The prompt landed on the session's default thread, not a stray one.
    const threadsRes = await fetch(`${api.baseUrl}/api/sessions/${body.id}/threads`);
    const threads = (await threadsRes.json()) as ListThreadsResponse;
    expect(threads.threads.map((t) => t.id)).toContain(submissions[0]?.threadId);

    // A queued turn reads `working`, both in the create response and the list.
    expect(body.runState).toBe("working");
    const listRes = await fetch(`${api.baseUrl}/api/sessions`);
    const list = (await listRes.json()) as ListSessionsResponse;
    expect(list.sessions.find((s) => s.id === body.id)?.runState).toBe("working");
  });

  it("queues nothing when initialPrompt is omitted", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-no-initial-prompt-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;

    expect(await submissionsFor(api, body.id)).toHaveLength(0);
    expect(body.runState).toBe("idle");
  });

  it("400s on a non-string initialPrompt", async () => {
    api = await bootTestApi();
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-bad-initial-prompt-"));

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, initialPrompt: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Zero-config repo sources (sandbox-reconciliation plan, Task 19) ──────────

describe("POST /api/sessions: zero-config repo sources", () => {
  let api: TestApi | undefined;
  let fixture: Awaited<ReturnType<typeof startGithubFixture>> | undefined;
  const REPO = { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" };

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  it("session create returns 201 immediately — ensureRepoSource is fire-and-forget", async () => {
    api = await bootTestApi({ imageBuilder: new FakeImageBuilder() });
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-zeroconf-fast-"));

    const t0 = Date.now();
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, repo: REPO }),
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(201);
    // The route must not block on bake work; 1.5 s is a tight upper bound.
    expect(elapsed).toBeLessThan(1_500);
  });

  it("with builder + org GitHub credential: upserts enabled repo source and queues a first bake", async () => {
    const builder = new FakeImageBuilder();
    // Wire a GitHub fixture so resolveHeadSha (inside startRepoBake) succeeds
    // without hitting the real GitHub API.
    fixture = startGithubFixture();
    api = await bootTestApi({ imageBuilder: builder, githubApiUrl: fixture.url });
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-zeroconf-bake-"));
    const { db, engineCredentials } = api.providers;

    // Seed an org-scoped GitHub credential so ensureRepoSource can fire the bake.
    await engineCredentials.save({ type: "org", id: "local-org" }, "github", {
      type: "api_key",
      accessToken: "test-pat",
      metadata: { login: "test-bot" },
    });

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, repo: REPO }),
    });
    expect(res.status).toBe(201);

    // Poll until the image_sources row exists.
    let sourceId: string;
    await vi.waitFor(
      async () => {
        const sources = await db
          .select()
          .from(imageSources)
          .where(eq(imageSources.repoFullName, "acme/widgets"));
        expect(sources).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    const sources = await db
      .select()
      .from(imageSources)
      .where(eq(imageSources.repoFullName, "acme/widgets"));
    expect(sources[0]?.kind).toBe("repo");
    expect(sources[0]?.enabled).toBe(true);
    sourceId = sources[0]!.id;

    // Poll until bakes exist for the source.
    await vi.waitFor(
      async () => {
        const bakeRows = await db
          .select()
          .from(bakes)
          .where(eq(bakes.sourceId, sourceId));
        expect(bakeRows.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 },
    );

    const bakeRows = await db
      .select()
      .from(bakes)
      .where(eq(bakes.sourceId, sourceId));
    expect(bakeRows.every((b) => b.status === "queued" || b.status === "building")).toBe(true);
  });

  it("without org GitHub credential: source row upserted but no bake queued", async () => {
    // No credential saved — ensureRepoSource must silently skip the bake.
    api = await bootTestApi({ imageBuilder: new FakeImageBuilder() });
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-zeroconf-nocred-"));
    const { db } = api.providers;

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, repo: REPO }),
    });
    expect(res.status).toBe(201);

    // Poll until the image_sources row exists (proves ensure ran).
    await vi.waitFor(
      async () => {
        const sources = await db
          .select()
          .from(imageSources)
          .where(eq(imageSources.repoFullName, "acme/widgets"));
        expect(sources).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    const sources = await db
      .select()
      .from(imageSources)
      .where(eq(imageSources.repoFullName, "acme/widgets"));
    expect(sources[0]?.kind).toBe("repo");
    expect(sources[0]?.enabled).toBe(true);

    const bakeRows = await db
      .select()
      .from(bakes)
      .where(eq(bakes.sourceId, sources[0]!.id));
    expect(bakeRows).toHaveLength(0);
  });

  it("without builder: source row upserted but no bake queued", async () => {
    // builder: null — ensureRepoSource must silently skip the bake.
    api = await bootTestApi({ imageBuilder: null });
    const workspace = await mkdtemp(join(tmpdir(), "valet-session-zeroconf-nobuilder-"));
    const { db, engineCredentials } = api.providers;

    await engineCredentials.save({ type: "org", id: "local-org" }, "github", {
      type: "api_key",
      accessToken: "test-pat",
      metadata: { login: "test-bot" },
    });

    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, repo: REPO }),
    });
    expect(res.status).toBe(201);

    // Poll until the image_sources row exists (proves ensure ran).
    await vi.waitFor(
      async () => {
        const sources = await db
          .select()
          .from(imageSources)
          .where(eq(imageSources.repoFullName, "acme/widgets"));
        expect(sources).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    const sources = await db
      .select()
      .from(imageSources)
      .where(eq(imageSources.repoFullName, "acme/widgets"));

    const bakeRows = await db
      .select()
      .from(bakes)
      .where(eq(bakes.sourceId, sources[0]!.id));
    expect(bakeRows).toHaveLength(0);
  });
});
