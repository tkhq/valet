/**
 * Version history REST (workflow detail page's History drawer): one
 * immutable snapshot per definition-changing save, v1 at create, renames
 * don't mint versions, stored definitions read back verbatim.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type {
  CreateWorkflowResponse,
  GetWorkflowVersionResponse,
  ListWorkflowVersionsResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function minimalDefinition(withSet = false): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [
    { id: "trigger", type: "trigger" },
    ...(withSet ? [{ id: "vals", type: "set", values: { ok: true } }] : []),
    { id: "stop", type: "stop", outcome: "success" },
  ];
  const edges = withSet
    ? [
        { from: "trigger", to: "vals" },
        { from: "vals", to: "stop" },
      ]
    : [{ from: "trigger", to: "stop" }];
  return { version: "dag/v1", nodes, edges };
}

async function createWorkflow(baseUrl: string): Promise<CreateWorkflowResponse> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name: "Versioned", definition: minimalDefinition() }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateWorkflowResponse;
}

describe("workflow version history", () => {
  it("v1 at create; definition changes mint versions; renames don't; old definitions read back", async () => {
    api = await bootTestApi();
    const wf = await createWorkflow(api.baseUrl);

    const v1List = (await (
      await fetch(`${api.baseUrl}/api/workflows/${wf.id}/versions`)
    ).json()) as ListWorkflowVersionsResponse;
    expect(v1List.versions.map((v) => v.version)).toEqual([1]);

    // Definition change → v2.
    const put = await fetch(`${api.baseUrl}/api/workflows/${wf.id}`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ name: "Versioned", definition: minimalDefinition(true) }),
    });
    expect(put.status).toBe(200);

    // Rename only → no new version.
    const rename = await fetch(`${api.baseUrl}/api/workflows/${wf.id}`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(rename.status).toBe(200);

    const list = (await (
      await fetch(`${api.baseUrl}/api/workflows/${wf.id}/versions`)
    ).json()) as ListWorkflowVersionsResponse;
    expect(list.versions.map((v) => v.version)).toEqual([2, 1]);

    const v1 = (await (
      await fetch(`${api.baseUrl}/api/workflows/${wf.id}/versions/1`)
    ).json()) as GetWorkflowVersionResponse;
    expect(v1.definition).toEqual(minimalDefinition());

    const v2 = (await (
      await fetch(`${api.baseUrl}/api/workflows/${wf.id}/versions/2`)
    ).json()) as GetWorkflowVersionResponse;
    expect(v2.definition).toEqual(minimalDefinition(true));
  });

  it("404s: unknown workflow, unknown version; 400 on a non-integer version", async () => {
    api = await bootTestApi();
    const wf = await createWorkflow(api.baseUrl);

    expect((await fetch(`${api.baseUrl}/api/workflows/wf_nope/versions`)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/workflows/${wf.id}/versions/99`)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/workflows/${wf.id}/versions/abc`)).status).toBe(400);
  });
});
