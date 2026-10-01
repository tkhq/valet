import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { workflowDefinitions, workflowRuns } from "../schema/index.js";
import type { ListWorkflowsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function seed(a: TestApi, runId: string, outcome: "failed" | "completed") {
  const now = Date.now();
  await a.providers.db.insert(workflowDefinitions).values({
    id: `wf-${runId}`, orgId: "local-org", ownerType: "user", ownerId: "local-user",
    name: `Workflow ${runId}`, definition: { version: "dag/v1" }, createdAt: now, updatedAt: now,
  });
  await a.providers.db.insert(workflowRuns).values({
    id: runId, workflowId: `wf-${runId}`, definitionVersionId: "v1", definition: { version: "dag/v1" },
    params: { workflowId: `wf-${runId}` }, ownerType: "user", ownerId: "local-user",
    status: "settled", outcome, createdAt: now, updatedAt: now,
  });
}

it("dismisses a failed run from the viewer's attention list only", async () => {
  api = await bootTestApi();
  await seed(api, "run-failed", "failed");
  await seed(api, "run-done", "completed");
  const latest = async () => {
    const body = await (await fetch(`${api!.baseUrl}/api/workflows`)).json() as ListWorkflowsResponse;
    return body.workflows.find((workflow) => workflow.id === "wf-run-failed")?.latestRun;
  };
  const dismiss = (runId: string) => fetch(`${api!.baseUrl}/api/workflows/runs/${runId}/dismiss`, { method: "POST" });

  expect(await latest()).toMatchObject({ runId: "run-failed", outcome: "failed" });
  expect((await latest())?.dismissed).toBeUndefined();
  expect((await dismiss("run-failed")).status).toBe(200);
  expect(await latest()).toMatchObject({ runId: "run-failed", outcome: "failed", dismissed: true });
  // Dismissing again is harmless.
  expect((await dismiss("run-failed")).status).toBe(200);
  expect((await dismiss("run-done")).status).toBe(409);
  expect((await dismiss("run-missing")).status).toBe(404);
  // Another person still sees the failure.
  const other = await (await fetch(`${api.baseUrl}/api/workflows`, { headers: { "x-valet-test-user-id": "test-member" } })).json() as ListWorkflowsResponse;
  expect(other.workflows.find((workflow) => workflow.id === "wf-run-failed")?.latestRun?.dismissed).toBeUndefined();
});
