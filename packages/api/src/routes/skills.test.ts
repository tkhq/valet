/**
 * `GET /api/skills` + `GET /api/skills/:name` — the read-only skill catalog
 * behind the web Skills tab. Exercises fixture `ValetPlugin`s injected via
 * `bootTestApi({ plugins })` rather than the bundled registry, so the suite
 * controls which skills exist and which plugin owns each one.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { GetSkillResponse, ListSkillsResponse } from "../wire/types.js";

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
      content: "# GitHub\n\nOpen a pull request with `github.create_pull_request`.\n",
      source: "plugin",
    },
  ],
};

const WORKSPACE_PLUGIN: ValetPlugin = {
  name: "fixture-workspace",
  version: "0.2.0",
  skills: [
    { name: "google-docs", description: "Edit a document.", content: "# Docs\n", source: "plugin" },
    {
      name: "google-sheets",
      content: "# Sheets\n\nReport for {{ quarter }}.\n",
      argsSchema: Type.Object({ quarter: Type.String() }),
      source: "plugin",
    },
  ],
};

/** No skills at all — must not appear in the listing. */
const BARE_PLUGIN: ValetPlugin = { name: "fixture-bare", version: "1.0.0" };

describe("GET /api/skills", () => {
  it("lists every plugin skill with its owning plugin name", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN, WORKSPACE_PLUGIN, BARE_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/skills`);
    expect(res.status).toBe(200);
    const { skills } = (await res.json()) as ListSkillsResponse;

    expect(skills).toEqual([
      {
        name: "github",
        description: "How to use the GitHub tools.",
        origin: "plugin",
        plugin: "fixture-github",
        takesArgs: false,
      },
      {
        name: "google-docs",
        description: "Edit a document.",
        origin: "plugin",
        plugin: "fixture-workspace",
        takesArgs: false,
      },
      {
        name: "google-sheets",
        origin: "plugin",
        plugin: "fixture-workspace",
        takesArgs: true,
      },
    ]);
  });

  it("omits the body from the listing", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/skills`);
    const body = await res.text();
    expect(body).not.toContain("create_pull_request");
  });

  it("returns an empty list when no plugin ships a skill", async () => {
    api = await bootTestApi({ plugins: [BARE_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/skills`);
    const { skills } = (await res.json()) as ListSkillsResponse;
    expect(skills).toEqual([]);
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/skills`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

/**
 * Paging and the Library's three filters. Both live on the server because a
 * filter applied to one page answers about that page while the control
 * claims to answer about the catalog — a search would miss every match on a
 * page not yet read.
 */
describe("GET /api/skills — paging and filters", () => {
  async function page(baseUrl: string, query: string): Promise<ListSkillsResponse> {
    const res = await fetch(`${baseUrl}/api/skills${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as ListSkillsResponse;
  }

  async function write(
    baseUrl: string,
    body: { name: string; description: string; content: string; invocation?: "context" | "prompt" },
  ): Promise<void> {
    const res = await fetch(`${baseUrl}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
  }

  it("walks the whole catalog with the cursor it hands back", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN, WORKSPACE_PLUGIN] });

    const first = await page(api.baseUrl, "?limit=2");
    expect(first.skills.map((s) => s.name)).toEqual(["github", "google-docs"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await page(api.baseUrl, `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.skills.map((s) => s.name)).toEqual(["google-sheets"]);
    expect(second.nextCursor).toBeNull();
  });

  it("crosses the plugin block into the stored rows without repeating a skill", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    await write(api.baseUrl, { name: "standup", description: "Summarize it.", content: "# S\n" });

    // One plugin skill, then one stored row: the page boundary falls exactly
    // where the two sources meet, which is the case a merged cursor gets
    // wrong by either repeating the plugin skill or skipping the stored one.
    const first = await page(api.baseUrl, "?limit=1");
    expect(first.skills.map((s) => s.name)).toEqual(["github"]);

    const second = await page(api.baseUrl, `?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.skills.map((s) => s.name)).toEqual(["standup"]);
    expect(second.nextCursor).toBeNull();
  });

  it("walks stored row to stored row one page at a time", async () => {
    api = await bootTestApi();
    for (const name of ["alpha", "beta", "gamma"]) {
      await write(api.baseUrl, { name, description: `The ${name} skill.`, content: `# ${name}\n` });
    }

    // Three pages of one, entirely inside the stored block. The sort key
    // holds an owner rank the database computes, so this is the case that
    // proves the cursor compares against that rank and not against a column.
    const names: string[] = [];
    let cursor: string | null = null;
    for (let read = 0; read < 3; read += 1) {
      const tail: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const body: ListSkillsResponse = await page(api.baseUrl, `?limit=1${tail}`);
      names.push(...body.skills.map((s) => s.name));
      cursor = body.nextCursor;
    }

    expect(names).toEqual(["alpha", "beta", "gamma"]);
    expect(cursor).toBeNull();
  });

  it("searches the whole catalog, not the page in hand", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN, WORKSPACE_PLUGIN] });
    await write(api.baseUrl, { name: "standup", description: "Summarize the sheets.", content: "# S\n" });

    // `google-sheets` sorts onto the second page of a two-row listing, and
    // `standup` matches on its description alone.
    const found = await page(api.baseUrl, "?limit=2&q=SHEETS");
    expect(found.skills.map((s) => s.name)).toEqual(["google-sheets", "standup"]);
  });

  it("finds a name holding a LIKE wildcard as written", async () => {
    api = await bootTestApi();
    await write(api.baseUrl, { name: "ab", description: "Two letters.", content: "# ab\n" });
    await write(api.baseUrl, { name: "a-b", description: "Hyphenated.", content: "# a-b\n" });

    // `_` matches any one character in LIKE. Unescaped, this search would
    // also return `a-b`.
    const found = await page(api.baseUrl, "?q=a_b");
    expect(found.skills.map((s) => s.name)).toEqual([]);
  });

  it("keeps the prompts, or everything but the prompts", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    await write(api.baseUrl, { name: "standup", description: "Ask.", content: "# S\n", invocation: "prompt" });
    await write(api.baseUrl, { name: "runbook", description: "Read.", content: "# R\n" });

    expect((await page(api.baseUrl, "?kind=prompt")).skills.map((s) => s.name)).toEqual(["standup"]);
    // A plugin skill declares no invocation, so it counts as a plain skill —
    // and so does a stored row that never set one.
    expect((await page(api.baseUrl, "?kind=skill")).skills.map((s) => s.name)).toEqual([
      "github",
      "runbook",
    ]);
  });

  it("narrows to one library scope, and to the plugin skills alone", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    await write(api.baseUrl, { name: "standup", description: "Ask.", content: "# S\n" });

    expect((await page(api.baseUrl, "?scope=personal")).skills.map((s) => s.name)).toEqual(["standup"]);
    expect((await page(api.baseUrl, "?scope=plugin")).skills.map((s) => s.name)).toEqual(["github"]);
    expect((await page(api.baseUrl, "?scope=org")).skills).toEqual([]);
  });

  it("400s a scope sent beside an owner pin, and names which to remove", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/skills?scope=personal&ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Remove scope");
  });

  it("400s a filter value it does not take, and names the values it does", async () => {
    api = await bootTestApi();

    const kind = await fetch(`${api.baseUrl}/api/skills?kind=recipe`);
    expect(kind.status).toBe(400);
    expect(((await kind.json()) as { error: string }).error).toContain("'skill' or 'prompt'");

    const scope = await fetch(`${api.baseUrl}/api/skills?scope=workspace`);
    expect(scope.status).toBe(400);
    expect(((await scope.json()) as { error: string }).error).toContain("'personal'");
  });

  it("400s a cursor it did not issue rather than restarting at page one", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/skills?cursor=nonsense`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("start at the first page");
  });

  it("still flags a shadowed row that the search keeps the shadower off", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    await write(api.baseUrl, { name: "github", description: "Mine.", content: "# G\n" });

    // Shadowing is a property of the whole reach. `q` selects the stored row
    // only, and the flag must still report the plugin skill that beats it.
    const found = await page(api.baseUrl, "?scope=personal");
    const [stored] = found.skills;
    expect(stored?.origin).not.toBe("plugin");
    expect(stored?.origin === "plugin" ? undefined : stored?.shadowed).toBe(true);
  });
});

describe("GET /api/skills/:name", () => {
  it("adds the markdown body to the summary", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN, WORKSPACE_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/skills/github`);
    expect(res.status).toBe(200);
    const skill = (await res.json()) as GetSkillResponse;

    expect(skill).toEqual({
      name: "github",
      description: "How to use the GitHub tools.",
      origin: "plugin",
      plugin: "fixture-github",
      takesArgs: false,
      content: "# GitHub\n\nOpen a pull request with `github.create_pull_request`.\n",
    });
  });

  it("keeps unfilled placeholders visible in the body", async () => {
    api = await bootTestApi({ plugins: [WORKSPACE_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/skills/google-sheets`);
    const skill = (await res.json()) as GetSkillResponse;
    expect(skill.content).toContain("{{ quarter }}");
    expect(skill.takesArgs).toBe(true);
  });

  it("404s for an unknown skill", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/skills/not-a-skill`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not-a-skill");
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/skills/github`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});
