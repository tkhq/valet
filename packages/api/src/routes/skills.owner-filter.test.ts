/**
 * The `?ownerType=&ownerId=` workspace filter on BOTH skill listings —
 * `GET /api/skills` and `GET /api/skills/sources`.
 *
 * The two must not drift, so every case runs against both: the same 400s,
 * the same 404, and a 404 body that tells a caller nothing about the owner
 * they asked for. Rows are seeded straight into the tables — the filter is
 * about which rows come back, and a real repository sync would only add a
 * network fixture to the run.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { addMember, createTeam } from "../services/teams.js";
import { skills, contentSources } from "../schema/index.js";
import type {
  ListSkillSourcesResponse,
  ListSkillsResponse,
  StoredSkillSummary,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const GITHUB_PLUGIN: ValetPlugin = {
  name: "fixture-github",
  version: "0.1.0",
  skills: [
    {
      name: "github",
      description: "How to use the GitHub tools.",
      content: "# GitHub\n",
      source: "plugin",
    },
  ],
};

interface Owner {
  type: "user" | "team" | "org";
  id: string;
}

async function seedSkill(target: TestApi, name: string, owner: Owner): Promise<void> {
  const now = Date.now();
  await target.providers.db.insert(skills).values({
    id: `skill_${name}_${owner.id}`,
    orgId: "local-org",
    ownerType: owner.type,
    ownerId: owner.id,
    origin: "local",
    name,
    description: `The ${name} skill.`,
    content: `# ${name}\n`,
    contentSha: `sha-${name}`,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedSource(target: TestApi, repo: string, owner: Owner): Promise<void> {
  const now = Date.now();
  await target.providers.db.insert(contentSources).values({
    id: `skillsrc_${repo.replace("/", "_")}_${owner.id}`,
    orgId: "local-org",
    ownerType: owner.type,
    ownerId: owner.id,
    repoFullName: repo,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

function get(baseUrl: string, path: string, query = "", userId?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/${path}${query}`, {
    headers: userId ? { "x-valet-test-user-id": userId } : {},
  });
}

async function skillNames(target: TestApi, query = "", userId?: string): Promise<string[]> {
  const res = await get(target.baseUrl, "skills", query, userId);
  expect(res.status).toBe(200);
  return ((await res.json()) as ListSkillsResponse).skills.map((s) => s.name);
}

async function sourceRepos(target: TestApi, query = "", userId?: string): Promise<string[]> {
  const res = await get(target.baseUrl, "skills/sources", query, userId);
  expect(res.status).toBe(200);
  return ((await res.json()) as ListSkillSourcesResponse).sources.map((s) => s.repo);
}

/**
 * A team `local-user` is on, holding one skill and one source, alongside a
 * personal skill and a personal source. Returns the team id.
 */
async function seedWorkspaces(target: TestApi): Promise<string> {
  const team = await createTeam(target.providers.db, {
    orgId: "local-org",
    name: "Platform",
    creatorUserId: "local-user",
  });
  await seedSkill(target, "deploy", { type: "user", id: "local-user" });
  await seedSkill(target, "on-call", { type: "team", id: team.id });
  await seedSource(target, "acme/personal-skills", { type: "user", id: "local-user" });
  await seedSource(target, "acme/team-skills", { type: "team", id: team.id });
  return team.id;
}

describe("GET /api/skills and /api/skills/sources without the filter", () => {
  it("still answers with the caller's own rows unioned with their teams'", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    await seedWorkspaces(api);

    expect(await skillNames(api)).toEqual(["github", "deploy", "on-call"]);
    expect(await sourceRepos(api)).toEqual(["acme/personal-skills", "acme/team-skills"]);
  });
});

describe("GET /api/skills and /api/skills/sources filtered to one owner", () => {
  it("returns a team's rows only, for a team the caller is on", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    const teamId = await seedWorkspaces(api);
    const query = `?ownerType=team&ownerId=${teamId}`;

    // No `github`: this asks for one owner's skills, and the plugin skill
    // has no owner to be selected by.
    expect(await skillNames(api, query)).toEqual(["on-call"]);
    expect(await sourceRepos(api, query)).toEqual(["acme/team-skills"]);
  });

  it("returns personal rows only when the filter names the caller", async () => {
    api = await bootTestApi();
    await seedWorkspaces(api);
    const query = "?ownerType=user&ownerId=local-user";

    expect(await skillNames(api, query)).toEqual(["deploy"]);
    expect(await sourceRepos(api, query)).toEqual(["acme/personal-skills"]);
  });

  it("returns the org library to a plain member, who cannot write it", async () => {
    api = await bootTestApi();
    await seedWorkspaces(api);
    await seedSkill(api, "handbook", { type: "org", id: "local-org" });
    await seedSource(api, "acme/org-skills", { type: "org", id: "local-org" });
    const query = "?ownerType=org&ownerId=local-org";

    // `test-member` is an org member and nothing more. The org library is
    // readable by every member, so this filter answers instead of 404ing —
    // the write rule stays stricter, and `skills.stored.test.ts` holds it.
    expect(await skillNames(api, query, "test-member")).toEqual(["handbook"]);
    expect(await sourceRepos(api, query, "test-member")).toEqual(["acme/org-skills"]);
  });

  it("hides no org row the same member reads without the filter", async () => {
    api = await bootTestApi();
    await seedWorkspaces(api);
    await seedSkill(api, "handbook", { type: "org", id: "local-org" });
    await seedSource(api, "acme/org-skills", { type: "org", id: "local-org" });

    // The other half of the test above, and the rule that binds the two: a
    // filter selects INSIDE the caller's reach. It never widens that reach,
    // and it must never hide a row the same caller already reads. An org
    // filter that answered 404 while the unfiltered listing showed the
    // library would say two different things about one row.
    expect(await skillNames(api, "", "test-member")).toContain("handbook");
    expect(await sourceRepos(api, "", "test-member")).toContain("acme/org-skills");
  });

  it("marks a stored skill a plugin shadows, even inside one workspace", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    const team = await createTeam(api.providers.db, {
      orgId: "local-org",
      name: "Platform",
      creatorUserId: "local-user",
    });
    await seedSkill(api, "github", { type: "team", id: team.id });

    const res = await get(api.baseUrl, "skills", `?ownerType=team&ownerId=${team.id}`);
    const { skills: listed } = (await res.json()) as ListSkillsResponse;

    // The callback narrows the union, so `stored` is a stored summary here.
    const stored = listed.find((s) => s.origin !== "plugin");
    if (stored === undefined) {
      throw new Error(`the team's skill was not listed: ${listed.map((s) => s.name).join(", ")}`);
    }
    expect(listed).toHaveLength(1);
    // The plugin keeps this row out of every session, so the team's own page
    // says so even though the plugin skill itself is not listed here.
    expect(stored.shadowed).toBe(true);
  });
});

describe("an owner the caller cannot reach", () => {
  it("404s a team the caller is not on, and names neither the team nor its id", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, {
      orgId: "local-org",
      name: "Platform",
      creatorUserId: "local-user",
    });
    await seedSkill(api, "on-call", { type: "team", id: team.id });
    await seedSource(api, "acme/team-skills", { type: "team", id: team.id });
    const query = `?ownerType=team&ownerId=${team.id}`;

    for (const path of ["skills", "skills/sources"]) {
      // `test-member` is an org member and nothing more. `local-user` would
      // be the wrong caller here: it is the org's admin.
      const res = await get(api.baseUrl, path, query, "test-member");
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain(team.id);
      expect(text).not.toContain("Platform");
    }
  });

  it("404s an owner that does not exist identically", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, {
      orgId: "local-org",
      name: "Platform",
      creatorUserId: "local-user",
    });

    for (const path of ["skills", "skills/sources"]) {
      const hidden = await get(api.baseUrl, path, `?ownerType=team&ownerId=${team.id}`, "test-member");
      const missing = await get(api.baseUrl, path, "?ownerType=team&ownerId=team_nope", "test-member");

      expect(hidden.status).toBe(missing.status);
      expect(await hidden.text()).toBe(await missing.text());
    }
  });

  it("404s another person's workspace, and an org that is not the caller's", async () => {
    api = await bootTestApi();
    await seedWorkspaces(api);

    for (const path of ["skills", "skills/sources"]) {
      expect((await get(api.baseUrl, path, "?ownerType=user&ownerId=test-member")).status).toBe(404);
      // The org library the caller may read is their OWN org's. Any other
      // org id must read exactly like an org that does not exist.
      expect((await get(api.baseUrl, path, "?ownerType=org&ownerId=other-org")).status).toBe(404);
    }
  });

  it("reaches a team once the caller joins it", async () => {
    api = await bootTestApi();
    const teamId = await seedWorkspaces(api);
    const query = `?ownerType=team&ownerId=${teamId}`;

    expect((await get(api.baseUrl, "skills", query, "test-member")).status).toBe(404);
    await addMember(api.providers.db, { teamId, userId: "test-member", role: "member" });

    expect(await skillNames(api, query, "test-member")).toEqual(["on-call"]);
    expect(await sourceRepos(api, query, "test-member")).toEqual(["acme/team-skills"]);
  });
});

describe("a filter that is only half given", () => {
  it("400s ownerType without ownerId, and names the fix", async () => {
    api = await bootTestApi();

    for (const path of ["skills", "skills/sources"]) {
      const res = await get(api.baseUrl, path, "?ownerType=team");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "Filter by owner with both ownerType and ownerId, or send neither.",
      );
    }
  });

  it("400s ownerId without ownerType, and names the fix", async () => {
    api = await bootTestApi();

    for (const path of ["skills", "skills/sources"]) {
      const res = await get(api.baseUrl, path, "?ownerId=team_1");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        "both ownerType and ownerId",
      );
    }
  });

  it("400s an ownerType that is not an owner type, and names the values it takes", async () => {
    api = await bootTestApi();

    for (const path of ["skills", "skills/sources"]) {
      const res = await get(api.baseUrl, path, "?ownerType=workspace&ownerId=team_1");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "ownerType must be 'user', 'team' or 'org'.",
      );
    }
  });

  it("answers the two listings with the same message", async () => {
    api = await bootTestApi();

    for (const query of ["?ownerType=team", "?ownerId=team_1", "?ownerType=nope&ownerId=team_1"]) {
      const catalog = await get(api.baseUrl, "skills", query);
      const sources = await get(api.baseUrl, "skills/sources", query);
      expect(catalog.status).toBe(sources.status);
      expect(await catalog.text()).toBe(await sources.text());
    }
  });
});

/**
 * Shadowing is a property of the caller's whole reach, not of the page.
 *
 * `listSkills` returns personal rows before team rows, and the first of a
 * repeated name is the one a session gets. A filtered page judged against
 * itself drops the row that actually wins, so the team's page would report
 * its skill live while a personal copy of the same name beat it in every
 * session — exactly the confusion the flag exists to prevent.
 */
describe("GET /api/skills — the shadow flag survives the filter", () => {
  /** The same skill name owned twice: once by the caller, once by their team. */
  async function seedClash(target: TestApi): Promise<string> {
    const team = await createTeam(target.providers.db, {
      orgId: "local-org",
      name: "Platform",
      creatorUserId: "local-user",
    });
    await seedSkill(target, "deploy", { type: "user", id: "local-user" });
    await seedSkill(target, "deploy", { type: "team", id: team.id });
    return team.id;
  }

  /** `SkillSummary` is a union and a plugin skill has no owner, so narrow on
   * the `origin` discriminant rather than reaching for fields the plugin
   * arm does not carry. */
  function storedRows(body: ListSkillsResponse): StoredSkillSummary[] {
    return body.skills.filter((s): s is StoredSkillSummary => s.origin !== "plugin");
  }

  function shadowedOf(body: ListSkillsResponse, ownerId: string): boolean | undefined {
    return storedRows(body).find((s) => s.ownerId === ownerId)?.shadowed;
  }

  it("flags the team row shadowed by a personal one the filter keeps off the page", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    const teamId = await seedClash(api);

    const res = await get(api.baseUrl, "skills", `?ownerType=team&ownerId=${teamId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListSkillsResponse;

    expect(shadowedOf(body, teamId)).toBe(true);
    // The row doing the shadowing is not on this page, which is the whole
    // reason judging the page against itself got this wrong.
    expect(storedRows(body).some((s) => s.ownerId === "local-user")).toBe(false);
  });

  it("does not flag the personal row, which is the copy that reaches a session", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    await seedClash(api);

    const res = await get(api.baseUrl, "skills", "?ownerType=user&ownerId=local-user");
    const body = (await res.json()) as ListSkillsResponse;
    expect(shadowedOf(body, "local-user")).toBe(false);
  });

  it("agrees with the unfiltered listing about both rows", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    const teamId = await seedClash(api);

    const res = await get(api.baseUrl, "skills");
    const body = (await res.json()) as ListSkillsResponse;
    expect(shadowedOf(body, "local-user")).toBe(false);
    expect(shadowedOf(body, teamId)).toBe(true);
  });
});
