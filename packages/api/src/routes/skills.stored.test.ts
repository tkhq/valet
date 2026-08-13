/**
 * `/api/skills` CRUD over stored skills, plus the origin and shadow fields
 * the catalog listing gained alongside it. The plugin-only behaviour stays
 * in `skills.test.ts`; this file covers what a database row adds.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createTeam } from "../services/teams.js";
import type {
  CreateSkillRequest,
  GetSkillResponse,
  ListSkillsResponse,
  SkillResponse,
  UpdateSkillRequest,
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

const DEPLOY: CreateSkillRequest = {
  name: "deploy",
  description: "How to deploy the service.",
  content: "# Deploy\n\nRun `make deploy`.\n",
};

async function post(baseUrl: string, body: CreateSkillRequest, userId?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/skills`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-valet-test-user-id": userId } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/skills", () => {
  it("creates a local skill owned by the caller", async () => {
    api = await bootTestApi();

    const res = await post(api.baseUrl, DEPLOY);
    expect(res.status).toBe(201);
    const skill = (await res.json()) as SkillResponse;

    expect(skill.name).toBe("deploy");
    expect(skill.origin).toBe("local");
    expect(skill.ownerType).toBe("user");
    expect(skill.shadowed).toBe(false);
    expect(skill.content).toContain("make deploy");
    expect(skill.id).toMatch(/^skill_/);
  });

  it("rejects a name the skill spec does not allow", async () => {
    api = await bootTestApi();

    const res = await post(api.baseUrl, { ...DEPLOY, name: "Deploy Now" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors?: string[] };
    expect(body.errors?.join(" ")).toContain("lowercase");
  });

  it("rejects a second skill with the same name", async () => {
    api = await bootTestApi();
    await post(api.baseUrl, DEPLOY);

    const res = await post(api.baseUrl, DEPLOY);
    expect(res.status).toBe(409);
  });

  it("404s a team the caller does not belong to", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, {
      orgId: "local-org",
      name: "Platform",
      creatorUserId: "local-user",
    });

    const res = await post(api.baseUrl, { ...DEPLOY, teamId: team.id }, "test-member");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/skills with stored skills", () => {
  it("reports the origin of every skill", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    await post(api.baseUrl, DEPLOY);

    const { skills } = (await (await fetch(`${api.baseUrl}/api/skills`)).json()) as ListSkillsResponse;
    const byName = new Map(skills.map((s) => [s.name, s]));

    expect(byName.get("github")?.origin).toBe("plugin");
    expect(byName.get("deploy")?.origin).toBe("local");
  });

  it("marks a stored skill a plugin skill shadows", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    await post(api.baseUrl, { ...DEPLOY, name: "github" });

    const { skills } = (await (await fetch(`${api.baseUrl}/api/skills`)).json()) as ListSkillsResponse;
    // The callback narrows the union, so `stored` is a stored summary here.
    const stored = skills.find((s) => s.origin !== "plugin");
    if (stored === undefined) {
      throw new Error(`no stored skill in the listing: ${skills.map((s) => s.name).join(", ")}`);
    }

    expect(stored.name).toBe("github");
    expect(stored.shadowed).toBe(true);
  });

  it("does not leak another user's skill", async () => {
    api = await bootTestApi();
    await post(api.baseUrl, DEPLOY);

    const res = await fetch(`${api.baseUrl}/api/skills`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const { skills } = (await res.json()) as ListSkillsResponse;
    expect(skills).toEqual([]);
  });
});

describe("GET /api/skills/stored/:id", () => {
  it("returns the body of a stored skill", async () => {
    api = await bootTestApi();
    const created = (await (await post(api.baseUrl, DEPLOY)).json()) as SkillResponse;

    const res = await fetch(`${api.baseUrl}/api/skills/stored/${created.id}`);
    expect(res.status).toBe(200);
    const skill = (await res.json()) as SkillResponse;
    expect(skill.content).toContain("make deploy");
  });

  it("404s another user's skill exactly like a missing one", async () => {
    api = await bootTestApi();
    const created = (await (await post(api.baseUrl, DEPLOY)).json()) as SkillResponse;

    const mine = await fetch(`${api.baseUrl}/api/skills/stored/${created.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const missing = await fetch(`${api.baseUrl}/api/skills/stored/skill_nope`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });

    expect(mine.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await mine.text()).toBe(await missing.text());
  });

  it("reads a shadowed skill that the name route cannot reach", async () => {
    api = await bootTestApi({ plugins: [GITHUB_PLUGIN] });
    const created = (await (
      await post(api.baseUrl, { ...DEPLOY, name: "github" })
    ).json()) as SkillResponse;

    const byId = (await (
      await fetch(`${api.baseUrl}/api/skills/stored/${created.id}`)
    ).json()) as SkillResponse;
    const byName = (await (
      await fetch(`${api.baseUrl}/api/skills/github`)
    ).json()) as GetSkillResponse;

    expect(byId.content).toContain("make deploy");
    expect(byName.content).toBe("# GitHub\n");
  });
});

describe("PATCH /api/skills/stored/:id", () => {
  it("updates the body", async () => {
    api = await bootTestApi();
    const created = (await (await post(api.baseUrl, DEPLOY)).json()) as SkillResponse;

    const body: UpdateSkillRequest = { content: "# New\n" };
    const res = await fetch(`${api.baseUrl}/api/skills/stored/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as SkillResponse;
    expect(updated.content).toBe("# New\n");
  });

  it("404s another user's skill", async () => {
    api = await bootTestApi();
    const created = (await (await post(api.baseUrl, DEPLOY)).json()) as SkillResponse;

    const res = await fetch(`${api.baseUrl}/api/skills/stored/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ content: "# Theirs\n" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a description the skill spec does not allow", async () => {
    api = await bootTestApi();
    const created = (await (await post(api.baseUrl, DEPLOY)).json()) as SkillResponse;

    const res = await fetch(`${api.baseUrl}/api/skills/stored/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/skills/stored/:id", () => {
  it("removes the skill", async () => {
    api = await bootTestApi();
    const created = (await (await post(api.baseUrl, DEPLOY)).json()) as SkillResponse;

    const res = await fetch(`${api.baseUrl}/api/skills/stored/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const { skills } = (await (await fetch(`${api.baseUrl}/api/skills`)).json()) as ListSkillsResponse;
    expect(skills).toEqual([]);
  });

  it("404s another user's skill", async () => {
    api = await bootTestApi();
    const created = (await (await post(api.baseUrl, DEPLOY)).json()) as SkillResponse;

    const res = await fetch(`${api.baseUrl}/api/skills/stored/${created.id}`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});
