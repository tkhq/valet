import { testWorkflowResourceContext } from "../test-helpers/resource-authorization.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { workflowDefinitions } from "../schema/index.js";
import { ResourceAuthorizationError, type ResourceAuthorizationPort } from "../authorization/resource-authorization.js";
import { createWorkflowDefinition, getWorkflowDefinition, type WorkflowServiceDeps } from "./service.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

function deps(port: ResourceAuthorizationPort): WorkflowServiceDeps {
  const p = api!.providers;
  return { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, resourceAuthorizationPort: port, resourceAuthorizationContext: testWorkflowResourceContext };
}

const owner = { userId: "local-user", orgId: "local-org", principal: { type: "user" as const, id: "local-user" } };
const definition = { version: "dag/v1", nodes: [{ id: "start", type: "trigger" }], edges: [] };

describe("workflow resource authorization boundary", () => {
  it.each(["deny", "indeterminate"] as const)("has no create side effect on %s", async (effect) => {
    api = await bootTestApi();
    const port: ResourceAuthorizationPort = { authorize: async () => { throw new ResourceAuthorizationError(effect); } };
    await expect(createWorkflowDefinition(deps(port), owner, { name: "Blocked", definition })).rejects.toThrow(ResourceAuthorizationError);
    expect(await api.providers.db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("authorizes safe owner and version metadata before reading a definition", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(workflowDefinitions).values({ id: "wf-safe", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Safe", definition, createdAt: 10, updatedAt: 20 });
    const authorize = vi.fn<ResourceAuthorizationPort["authorize"]>().mockResolvedValue({ schemaVersion: 1, readOnly: false, redactions: [] });
    await expect(getWorkflowDefinition(deps({ authorize }), owner, "wf-safe")).resolves.toMatchObject({ id: "wf-safe" });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ resourceKind: "workflow", operation: "read", resource: { id: "wf-safe", ownerType: "user", ownerId: "local-user", version: 20 } }));
    expect(JSON.stringify(authorize.mock.calls[0])).not.toContain("dag/v1");

    authorize.mockClear();
    await expect(getWorkflowDefinition(deps({ authorize }), { ...owner, orgId: "other-org" }, "wf-safe")).resolves.toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("denies an unknown resource operation without evaluation", async () => {
    api = await bootTestApi();
    const authorize = vi.spyOn(api.providers.canonicalAuthorizationService, "authorize");
    await expect(api.providers.resourceAuthorizationPort.authorize({ ...testWorkflowResourceContext(owner), resourceKind: "workflow", operation: "unknown" as never })).rejects.toMatchObject({ effect: "deny" });
    expect(authorize).not.toHaveBeenCalled();
  });

});
