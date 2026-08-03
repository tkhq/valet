/**
 * POST /api/sessions — Task 5 (sandbox auth gateway plan): create accepts
 * an optional `profile` ("headless" | "full"), persists it, and returns it.
 * Omitting `profile` defaults to "headless".
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, sessionRepos } from "../schema/index.js";
import type { CreateSessionResponse, GetSessionResponse } from "../wire/types.js";

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
