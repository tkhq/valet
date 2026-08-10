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
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
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

function entry(name: string) {
  return { name, path: name, type: "dir", size: 0, sha: `sha-${name}` };
}

/** A repository the test can move forward between calls. */
interface RepoState {
  sha: string;
  names: string[];
}

/** Serves `state`, each named directory holding a well-formed skill. */
function serve(state: RepoState): GithubFixture {
  fixture = startGithubFixture({
    getCommit: () => ({ body: { sha: state.sha } }),
    getContents: (_owner, _repo, path) => {
      if (path === "") return { body: state.names.map(entry) };
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
