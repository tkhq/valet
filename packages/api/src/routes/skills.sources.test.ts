/**
 * `/api/skills/sources` — adding, listing, syncing, and removing a tracked
 * skill repository over HTTP.
 *
 * A real API boot with a real GitHub fixture behind it, so an import here
 * goes all the way to `skills` rows. `bootTestApi`'s `githubApiUrl` points
 * the sync reader at the fixture.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  commitBody,
  startGithubFixture,
  treeEntry,
  type GithubFixture,
} from "../test-helpers/github-fixture.js";
import { createTeam } from "../services/teams.js";
import type {
  CreateSkillSourceRequest,
  ListSkillSourcesResponse,
  ListSkillsResponse,
  SkillSourceSyncResponse,
} from "../wire/types.js";

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
});

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`;
}

/** A repository the test can move forward between calls. */
interface RepoState {
  sha: string;
  names: string[];
}

/** Serves `state`, each named directory holding a well-formed skill. */
function serve(state: RepoState): GithubFixture {
  fixture = startGithubFixture({
    getCommit: () => ({ body: commitBody(state.sha) }),
    getTree: () => ({
      body: {
        sha: `tree-${state.sha}`,
        truncated: false,
        tree: state.names.map((name) =>
          treeEntry(`${name}/SKILL.md`, { sha: `blob-${state.sha}-${name}` }),
        ),
      },
    }),
    getContents: (_owner, _repo, path) => {
      const dir = /^(.*)\/SKILL\.md$/.exec(path)?.[1];
      if (dir === undefined || !state.names.includes(dir)) {
        return { status: 404, body: { message: "Not Found" } };
      }
      return {
        body: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(skillMd(dir, `The ${dir} skill.`), "utf8").toString("base64"),
          sha: `blob-${dir}`,
        },
      };
    },
  });
  return fixture;
}

async function post(
  baseUrl: string,
  body: CreateSkillSourceRequest,
  userId?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/skills/sources`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-valet-test-user-id": userId } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/skills/sources", () => {
  it("imports the repository's skills as it adds the source", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy", "on-call"] });
    api = await bootTestApi({ githubApiUrl: f.url });

    const res = await post(api.baseUrl, { repo: "https://github.com/tkhq/skills" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SkillSourceSyncResponse;

    expect(body.imported).toBe(2);
    expect(body.source.repo).toBe("tkhq/skills");
    expect(body.source.status).toBe("ok");
    expect(body.source.skillCount).toBe(2);
    expect(body.source.lastSyncedAt).not.toBeNull();

    const catalog = (await (await fetch(`${api.baseUrl}/api/skills`)).json()) as ListSkillsResponse;
    const imported = catalog.skills.filter((s) => s.origin === "repo");
    expect(imported.map((s) => s.name).sort()).toEqual(["deploy", "on-call"]);
  });

  it("names the public-only limit when the repository 404s", async () => {
    fixture = startGithubFixture({
      getCommit: () => ({ status: 404, body: { message: "Not Found" } }),
    });
    api = await bootTestApi({ githubApiUrl: fixture.url });

    const res = await post(api.baseUrl, { repo: "tkhq/private" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SkillSourceSyncResponse;

    expect(body.source.status).toBe("error");
    expect(body.source.lastMessage).toContain("public");
    expect(body.source.lastMessage).toMatch(/spelling|private/);
  });

  it("rejects text that is not a repository", async () => {
    fixture = startGithubFixture({});
    api = await bootTestApi({ githubApiUrl: fixture.url });

    const res = await post(api.baseUrl, { repo: "https://gitlab.com/tkhq/skills" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("GitHub");
  });

  it("rejects the same repository twice", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    await post(api.baseUrl, { repo: "tkhq/skills" });

    const res = await post(api.baseUrl, { repo: "tkhq/skills" });
    expect(res.status).toBe(409);
  });

  it("404s a team the caller does not belong to", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    const team = await createTeam(api.providers.db, {
      orgId: "local-org",
      name: "Platform",
      creatorUserId: "local-user",
    });

    const res = await post(api.baseUrl, { repo: "tkhq/skills", teamId: team.id }, "test-member");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/skills/sources", () => {
  it("lists the caller's sources and is not swallowed by the skill-by-name route", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    await post(api.baseUrl, { repo: "tkhq/skills" });

    const res = await fetch(`${api.baseUrl}/api/skills/sources`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListSkillSourcesResponse;

    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]?.repo).toBe("tkhq/skills");
    expect(body.sources[0]?.skillCount).toBe(1);
  });

  it("does not show another person's sources", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    await post(api.baseUrl, { repo: "tkhq/skills" });

    const res = await fetch(`${api.baseUrl}/api/skills/sources`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(((await res.json()) as ListSkillSourcesResponse).sources).toEqual([]);
  });
});

describe("GET /api/skills/sources — paging", () => {
  async function page(baseUrl: string, query: string): Promise<ListSkillSourcesResponse> {
    const res = await fetch(`${baseUrl}/api/skills/sources${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as ListSkillSourcesResponse;
  }

  it("walks the whole set with the cursor it hands back", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    for (const repo of ["tkhq/a", "tkhq/b", "tkhq/c"]) await post(api.baseUrl, { repo });

    const first = await page(api.baseUrl, "?limit=2");
    expect(first.sources.map((s) => s.repo)).toEqual(["tkhq/a", "tkhq/b"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await page(api.baseUrl, `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.sources.map((s) => s.repo)).toEqual(["tkhq/c"]);
    // The last page says so, which is what disables the pager's Next.
    expect(second.nextCursor).toBeNull();
  });

  it("counts the skills of the sources on the page, not of every source", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    for (const repo of ["tkhq/a", "tkhq/b"]) await post(api.baseUrl, { repo });

    const first = await page(api.baseUrl, "?limit=1");
    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]?.skillCount).toBe(1);
  });

  it("400s a limit that is not a whole number, and names the fix", async () => {
    api = await bootTestApi();

    for (const bad of ["0", "-3", "two", "1.5"]) {
      const res = await fetch(`${api.baseUrl}/api/skills/sources?limit=${bad}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("Remove it to take the default");
    }
  });

  it("400s a cursor it did not issue rather than restarting at page one", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/skills/sources?cursor=nonsense`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("start at the first page");
  });
});

describe("POST /api/skills/sources/:id/sync", () => {
  it("re-reads the repository and applies what changed", async () => {
    const repo: RepoState = { sha: "commit-1", names: ["deploy"] };
    const f = serve(repo);
    api = await bootTestApi({ githubApiUrl: f.url });
    const created = (await (
      await post(api.baseUrl, { repo: "tkhq/skills" })
    ).json()) as SkillSourceSyncResponse;

    // The repository gains a skill at a new commit.
    repo.sha = "commit-2";
    repo.names.push("on-call");

    const res = await fetch(`${api.baseUrl}/api/skills/sources/${created.source.id}/sync`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SkillSourceSyncResponse;

    expect(body.imported).toBe(1);
    expect(body.source.skillCount).toBe(2);
  });

  it("404s an id the caller cannot reach", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    const created = (await (
      await post(api.baseUrl, { repo: "tkhq/skills" })
    ).json()) as SkillSourceSyncResponse;

    const res = await fetch(`${api.baseUrl}/api/skills/sources/${created.source.id}/sync`, {
      method: "POST",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});

describe("org-scoped skill sources", () => {
  it("admin creates an org source; every member sees it in the list", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });

    // `local-user` is the org admin in the test setup.
    const res = await post(api.baseUrl, { repo: "tkhq/skills", ownerType: "org" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as SkillSourceSyncResponse;
    expect(created.source.ownerType).toBe("org");

    // A member with no personal sources still sees the org source.
    const list = (await (
      await fetch(`${api.baseUrl}/api/skills/sources`, {
        headers: { "x-valet-test-user-id": "test-member" },
      })
    ).json()) as ListSkillSourcesResponse;
    expect(list.sources.map((s) => s.ownerType)).toEqual(["org"]);
    expect(list.sources[0]?.repo).toBe("tkhq/skills");
  });

  it("member cannot create an org source", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });

    const res = await post(api.baseUrl, { repo: "tkhq/skills", ownerType: "org" }, "test-member");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("admin");
  });

  it("member cannot delete or sync an org source", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    const created = (await (
      await post(api.baseUrl, { repo: "tkhq/skills", ownerType: "org" })
    ).json()) as SkillSourceSyncResponse;

    const del = await fetch(`${api.baseUrl}/api/skills/sources/${created.source.id}`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(del.status).toBe(404);

    const sync = await fetch(`${api.baseUrl}/api/skills/sources/${created.source.id}/sync`, {
      method: "POST",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(sync.status).toBe(404);
  });

  it("member still creates a personal source", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });

    const res = await post(api.baseUrl, { repo: "tkhq/skills" }, "test-member");
    expect(res.status).toBe(201);
    const created = (await res.json()) as SkillSourceSyncResponse;
    expect(created.source.ownerType).toBe("user");
  });

  it("an org source produces org-owned skills", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    await post(api.baseUrl, { repo: "tkhq/skills", ownerType: "org" });

    const catalog = (await (await fetch(`${api.baseUrl}/api/skills`)).json()) as ListSkillsResponse;
    const imported = catalog.skills.filter((s) => s.origin === "repo");
    expect(imported).toHaveLength(1);
    // The catalog union narrows on `origin`; a repo skill is a stored summary.
    const stored = imported[0];
    expect(stored && "ownerType" in stored ? stored.ownerType : undefined).toBe("org");
  });
});

describe("DELETE /api/skills/sources/:id", () => {
  it("removes the source and the skills it mirrored", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy", "on-call"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    const created = (await (
      await post(api.baseUrl, { repo: "tkhq/skills" })
    ).json()) as SkillSourceSyncResponse;

    const res = await fetch(`${api.baseUrl}/api/skills/sources/${created.source.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const catalog = (await (await fetch(`${api.baseUrl}/api/skills`)).json()) as ListSkillsResponse;
    expect(catalog.skills.filter((s) => s.origin === "repo")).toEqual([]);
    const list = (await (
      await fetch(`${api.baseUrl}/api/skills/sources`)
    ).json()) as ListSkillSourcesResponse;
    expect(list.sources).toEqual([]);
  });

  it("404s an id the caller cannot reach", async () => {
    const f = serve({ sha: "commit-1", names: ["deploy"] });
    api = await bootTestApi({ githubApiUrl: f.url });
    const created = (await (
      await post(api.baseUrl, { repo: "tkhq/skills" })
    ).json()) as SkillSourceSyncResponse;

    const res = await fetch(`${api.baseUrl}/api/skills/sources/${created.source.id}`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});
