/**
 * Workflow import: reading a definition out of a public repository, and the
 * refusals that keep a bad definition from becoming a row.
 *
 * The import client posts what it read to `POST /api/workflows`, so the two
 * halves are tested together here — a file that reaches the browser but is
 * then refused at create is the failure this feature exists to make visible.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import type {
  CreateWorkflowResponse,
  GetWorkflowImportFileResponse,
  ListWorkflowsResponse,
  ValidationErrorResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;
const prevGithubApiUrl = process.env.GITHUB_API_URL;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
});

function useFixture(overrides: Parameters<typeof startGithubFixture>[0] = {}): GithubFixture {
  fixture = startGithubFixture(overrides);
  process.env.GITHUB_API_URL = fixture.url;
  return fixture;
}

/** GitHub answers the contents endpoint with base64, which is what the
 * reader decodes. A fixture that returned plain text would pass a reader
 * that never decoded anything. `sha` is on every real file response, and
 * the reader refuses one without it — skill sync uses it as a manifest key
 * and cannot tell two versions of a file apart otherwise. */
function fileResponse(body: string): { body: Record<string, unknown> } {
  return {
    body: {
      type: "file",
      encoding: "base64",
      size: Buffer.byteLength(body),
      content: Buffer.from(body, "utf8").toString("base64"),
      sha: "blob-1",
    },
  };
}

function action(id: string): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ success: true, data: {} }),
  };
}

const notesActions: ActionPlugin = { service: "notes", actions: [action("notes.read")] };
const notesPlugin: ValetPlugin = { name: "notes", version: "0.0.1", actions: [notesActions] };

/** A definition every validator hook accepts, given `notesPlugin`. */
const IMPORTABLE = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "read", type: "tool", service: "notes", action: "read", params: {} },
    { id: "stop", type: "stop" },
  ],
  edges: [
    { from: "trigger", to: "read" },
    { from: "read", to: "stop" },
  ],
};

describe("GET /api/workflows/import/repo-file", () => {
  it("returns the file body, and reads the ref the caller asked for", async () => {
    api = await bootTestApi();
    const f = useFixture({ getContents: () => fileResponse(JSON.stringify(IMPORTABLE)) });

    const res = await fetch(
      `${api.baseUrl}/api/workflows/import/repo-file?repo=acme/automations&path=workflows/deploy.json&ref=release`,
      { headers: HEADERS },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetWorkflowImportFileResponse;
    expect(body.repo).toBe("acme/automations");
    expect(body.path).toBe("workflows/deploy.json");
    expect(body.ref).toBe("release");
    expect(JSON.parse(body.content)).toEqual(IMPORTABLE);

    const call = f.calls.find((c) => c.path.includes("/contents/"));
    expect(call?.params.owner).toBe("acme");
    expect(call?.params.repo).toBe("automations");
    expect(call?.params.path).toBe("workflows/deploy.json");
    expect(call?.query.ref).toBe("release");
  });

  it("sends no credential, because this path reads public repositories only", async () => {
    api = await bootTestApi();
    const f = useFixture({ getContents: () => fileResponse(JSON.stringify(IMPORTABLE)) });

    const res = await fetch(
      `${api.baseUrl}/api/workflows/import/repo-file?repo=https://github.com/acme/automations&path=deploy.json`,
      { headers: HEADERS },
    );
    expect(res.status).toBe(200);
    const call = f.calls.find((c) => c.path.includes("/contents/"));
    expect(call?.authHeader).toBeUndefined();
  });

  it("names the public-repository rule when GitHub has no such file", async () => {
    api = await bootTestApi();
    useFixture({ getContents: () => ({ status: 404, body: { message: "Not Found" } }) });

    const res = await fetch(
      `${api.baseUrl}/api/workflows/import/repo-file?repo=acme/private&path=deploy.json`,
      { headers: HEADERS },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("public repositories only");
    expect(body.error).toContain("make the repository public");
  });

  it("refuses a path that holds a directory, not a file", async () => {
    api = await bootTestApi();
    useFixture({ getContents: () => ({ body: [{ type: "file", name: "deploy.json" }] }) });

    const res = await fetch(
      `${api.baseUrl}/api/workflows/import/repo-file?repo=acme/automations&path=workflows`,
      { headers: HEADERS },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no file at workflows");
  });

  it("asks for the missing field when repo or path is blank", async () => {
    api = await bootTestApi();

    const noRepo = await fetch(`${api.baseUrl}/api/workflows/import/repo-file?path=deploy.json`, {
      headers: HEADERS,
    });
    expect(noRepo.status).toBe(400);
    expect(((await noRepo.json()) as { error: string }).error).toContain("owner/repo");

    const noPath = await fetch(`${api.baseUrl}/api/workflows/import/repo-file?repo=acme/automations`, {
      headers: HEADERS,
    });
    expect(noPath.status).toBe(400);
    expect(((await noPath.json()) as { error: string }).error).toContain("workflows/deploy.json");
  });

  it("refuses a host that is not GitHub", async () => {
    api = await bootTestApi();

    const res = await fetch(
      `${api.baseUrl}/api/workflows/import/repo-file?repo=https://gitlab.com/acme/automations&path=deploy.json`,
      { headers: HEADERS },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not GitHub");
  });

  it("refuses a path that leaves the repository", async () => {
    api = await bootTestApi();

    const res = await fetch(
      `${api.baseUrl}/api/workflows/import/repo-file?repo=acme/automations&path=../../etc/passwd`,
      { headers: HEADERS },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("leaves the repository");
  });

  it("names the size limit when GitHub serves the entry with no inline body", async () => {
    api = await bootTestApi();
    // How GitHub answers for a file over 1 MB: the entry, with the body left out.
    useFixture({ getContents: () => ({
        body: { type: "file", encoding: "none", content: "", size: 2_000_000, sha: "blob-big" },
      }) });

    const res = await fetch(
      `${api.baseUrl}/api/workflows/import/repo-file?repo=acme/automations&path=huge.json`,
      { headers: HEADERS },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("1 MB");
  });
});

describe("importing what was read", () => {
  it("creates the workflow, and it appears in the list", async () => {
    api = await bootTestApi({ plugins: [notesPlugin] });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Imported deploy", definition: IMPORTABLE }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreateWorkflowResponse;
    expect(created.name).toBe("Imported deploy");
    expect(created.definition).toEqual(IMPORTABLE);

    const listRes = await fetch(`${api.baseUrl}/api/workflows`, { headers: HEADERS });
    const list = (await listRes.json()) as ListWorkflowsResponse;
    expect(list.workflows.map((w) => w.id)).toContain(created.id);
  });

  it("refuses a broken definition with the validator's own messages", async () => {
    api = await bootTestApi({ plugins: [notesPlugin] });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "Imported deploy",
        definition: {
          version: "dag/v1",
          nodes: [
            { id: "trigger", type: "trigger" },
            { id: "read", type: "tool", service: "notes", action: "read", params: {} },
          ],
          edges: [{ from: "trigger", to: "ghost" }],
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ValidationErrorResponse;
    expect(body.error).toBe("invalid workflow definition");
    // The node the author has to fix must be named, not just the fact of failure.
    expect(body.errors.some((e) => e.includes("ghost"))).toBe(true);

    const listRes = await fetch(`${api.baseUrl}/api/workflows`, { headers: HEADERS });
    expect(((await listRes.json()) as ListWorkflowsResponse).workflows).toEqual([]);
  });

  it("refuses a definition that names a service this deployment does not have", async () => {
    api = await bootTestApi({ plugins: [notesPlugin] });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "Imported deploy",
        definition: {
          ...IMPORTABLE,
          nodes: [
            { id: "trigger", type: "trigger" },
            { id: "read", type: "tool", service: "notez", action: "read", params: {} },
            { id: "stop", type: "stop" },
          ],
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ValidationErrorResponse;
    expect(body.errors.some((e) => e.includes('unknown tool.service "notez"'))).toBe(true);

    const listRes = await fetch(`${api.baseUrl}/api/workflows`, { headers: HEADERS });
    expect(((await listRes.json()) as ListWorkflowsResponse).workflows).toEqual([]);
  });
});
