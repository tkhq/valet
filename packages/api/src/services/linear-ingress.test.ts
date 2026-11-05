import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import linearPlugin from "@valet/plugin-linear/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventSubscriptions, linearInstallations, workflowDefinitions } from "../schema/index.js";
import { getLinearIngressStatus } from "./linear-ingress.js";
import { createWorkflowTrigger, updateWorkflowTrigger } from "../workflows/trigger-service.js";
import type { GetEventCatalogResponse, GetWorkflowTriggerCatalogResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
async function setup() { api = await bootTestApi({ plugins: [linearPlugin] }); return api; }
async function install(target: TestApi, orgId = "local-org", webhookId: string | null = "webhook") {
  await target.providers.db.insert(linearInstallations).values({ id: `install-${orgId}`, orgId, workspaceId: `workspace-${orgId}`, workspaceName: "Linear", webhookId, connectedBy: "local-user", createdAt: 1, updatedAt: 1 });
}

describe("Linear organization ingress readiness", () => {
  it("ignores personal connections and another organization's installation", async () => {
    const target = await setup(); const { db, engineCredentials } = target.providers;
    await engineCredentials.save({ type: "user", id: "local-user" },"linear",{ type: "oauth2", accessToken: "personal", metadata: { webhookSecret: "personal-secret" } });
    await install(target,"other-org");
    await engineCredentials.save({ type: "org", id: "other-org" },"linear",{ type: "oauth2", accessToken: "other", metadata: { webhookSecret: "other-secret" } });
    await engineCredentials.save({ type: "org", id: "local-org" },"linear_app",{ type: "service_account", apiKey: "secret", metadata: { clientId: "app" } });
    expect(await getLinearIngressStatus(db,engineCredentials,"local-org")).toMatchObject({ configured: true, clientId: "app", connected: false, ready: false, reason: expect.stringContaining("Personal connections") });
    await engineCredentials.delete({ type: "org", id: "local-org" },"linear_app");
    expect(await getLinearIngressStatus(db,engineCredentials,"local-org")).toMatchObject({ configured: false, ready: false, reason: expect.stringContaining("connect Linear") });
  });
  it("requires a nonempty signing secret for the connected workspace", async () => {
    const target = await setup(); const { db, engineCredentials } = target.providers;
    await install(target,"local-org",null);
    const org = { type: "org" as const, id: "local-org" };
    await engineCredentials.save(org,"linear",{ type: "oauth2", accessToken: "token", metadata: { webhookSecret: "signing-secret", workspaceId: "workspace-local-org" } });
    expect(await getLinearIngressStatus(db,engineCredentials,"local-org")).toEqual({ configured: false, connected: true, ready: true, webhookConfigured: true, workspaceName: "Linear" });
    await engineCredentials.save(org,"linear",{ type: "oauth2", accessToken: "token", metadata: { webhookSecret: " ", workspaceId: "workspace-local-org" } });
    expect(await getLinearIngressStatus(db,engineCredentials,"local-org")).toMatchObject({ ready: false, webhookConfigured: false, reason: expect.stringContaining("reconnect Linear") });
    await engineCredentials.save(org,"linear",{ type: "oauth2", accessToken: "token", metadata: { webhookSecret: "signing-secret", workspaceId: "wrong-workspace" } });
    expect((await getLinearIngressStatus(db,engineCredentials,"local-org")).ready).toBe(false);
  });
  it("exposes safe readiness in both catalogs for members while connection management stays admin-only", async () => {
    const target = await setup();
    const headers = { "x-valet-test-user-id": "test-member" };
    const workflows = await (await fetch(`${target.baseUrl}/api/workflows/trigger-catalog`,{ headers })).json() as GetWorkflowTriggerCatalogResponse;
    const events = await (await fetch(`${target.baseUrl}/api/events/catalog`,{ headers })).json() as GetEventCatalogResponse;
    expect(workflows.catalog.find(service => service.service === "linear")?.readiness?.ready).toBe(false);
    expect(events.services.find(service => service.service === "linear")?.readiness?.ready).toBe(false);
    expect((await fetch(`${target.baseUrl}/api/org/linear`,{ headers })).status).toBe(403);
    expect(JSON.stringify([workflows,events])).not.toMatch(/accessToken|webhookSecret|LINEAR_CLIENT_SECRET/);
  });
  it("blocks creating and enabling disconnected Linear triggers, but allows disabling and renaming old rules", async () => {
    const target = await setup(); const { db, engineCredentials } = target.providers;
    const deps = { db, credentials: engineCredentials, plugins: [linearPlugin] };
    const owner = { orgId: "local-org", userId: "local-user" };
    await db.insert(workflowDefinitions).values({ id: "wf", orgId: owner.orgId, ownerType: "user", ownerId: owner.userId, name: "wf", definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: 1, updatedAt: 1 });
    const input = { workflowId: "wf", name: "On Linear issue", eventKeys: ["linear.issue.create"] };
    expect(await createWorkflowTrigger(deps,owner,input)).toMatchObject({ ok: false, error: expect.stringContaining("Organization settings > Linear") });
    await db.insert(eventSubscriptions).values({ id: "old", orgId: owner.orgId, ownerType: "user", ownerId: owner.userId, name: "Old", eventKeys: input.eventKeys, filters: [], target: { kind: "workflow", workflowId: "wf" }, enabled: true, createdBy: owner.userId, createdAt: 1, updatedAt: 1 });
    expect(await updateWorkflowTrigger(deps,owner,"old",{ name: "Renamed" })).toMatchObject({ ok: true });
    expect(await updateWorkflowTrigger(deps,owner,"old",{ enabled: false })).toMatchObject({ ok: true, trigger: { enabled: false } });
    expect(await updateWorkflowTrigger(deps,owner,"old",{ enabled: true })).toMatchObject({ ok: false, status: 400 });
    await install(target);
    await engineCredentials.save({ type: "org", id: owner.orgId },"linear",{ type: "oauth2", accessToken: "org-token", metadata: { webhookSecret: "signing-secret" } });
    expect(await createWorkflowTrigger(deps,owner,input)).toMatchObject({ ok: true });
    expect(await updateWorkflowTrigger(deps,owner,"old",{ enabled: true })).toMatchObject({ ok: true, trigger: { enabled: true } });
  });
});
