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
