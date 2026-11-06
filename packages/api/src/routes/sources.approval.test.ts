/**
 * Second-admin approval for image-source changes
 * (`bakes/source-change-requests.ts`). The test api seeds two org admins,
 * `local-user` (default identity) and `test-admin`, plus a member.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { imageSourceChangeRequests, imageSources, notifications, orgMembers } from "../schema/index.js";
import type { ListSourceChangesResponse, PendingSourceChangeResponse, ResolveSourceChangeResponse } from "../wire/types.js";

const REQUESTER = { "Content-Type": "application/json" };
const APPROVER = { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" };
const MEMBER = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;

beforeEach(() => {
  vi.stubEnv("VALET_IMAGE_SOURCE_APPROVAL", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await api?.cleanup();
  api = undefined;
});

async function post(path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return fetch(`${api!.baseUrl}${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function requestExternal(name = "Probe image"): Promise<PendingSourceChangeResponse["pendingChange"]> {
  const res = await post("/api/org/sources", REQUESTER, { kind: "external", name, externalRef: "ghcr.io/acme/tools:1" });
  expect(res.status).toBe(202);
  return ((await res.json()) as PendingSourceChangeResponse).pendingChange;
}

async function sourceRows() {
  return api!.providers.db.select().from(imageSources).where(eq(imageSources.orgId, "local-org"));
}

/** A custom base that exists already. It is not one of the built-in
 * sources (`stock-full`, `default-full`), which refuse API edits outright. */
async function seedBase(setupCommands: string[] = []) {
  const now = Date.now();
  const row = {
    id: "src_custom_tools",
    orgId: "local-org",
    kind: "base" as const,
    parentId: null,
    name: "custom-tools",
    externalRef: null,
    pullSecretName: null,
    setupCommands,
    profile: null,
    repoHost: null,
    repoFullName: null,
    cloneUrl: null,
    schedule: "nightly" as const,
    enabled: true,
    lastBoundAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await api!.providers.db.insert(imageSources).values(row);
  return row;
}

describe("image-source changes wait for a second admin", () => {
  it("holds a create as a pending change, notifies the other admin, and applies it on approval", async () => {
    api = await bootTestApi();
    const pending = await requestExternal();
    expect(pending).toMatchObject({ action: "create", sourceName: "Probe image", requestedBy: "local-user", status: "pending" });
    expect(await sourceRows()).toEqual([]);

    const notes = await api.providers.db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(notes.map((n) => n.userId)).toEqual(["test-admin"]);
    expect(notes[0]?.title).toBe("Approve image source change: Probe image");

    const list = await fetch(`${api.baseUrl}/api/org/sources/changes`, { headers: APPROVER });
    expect(((await list.json()) as ListSourceChangesResponse).changes.map((c) => c.id)).toEqual([pending.id]);

    const approve = await post(`/api/org/sources/changes/${pending.id}/approve`, APPROVER);
    expect(approve.status).toBe(200);
    const body = (await approve.json()) as ResolveSourceChangeResponse;
    expect(body.change).toMatchObject({ status: "approved", decidedBy: "test-admin" });
    expect((await sourceRows()).map((r) => [r.name, r.externalRef])).toEqual([["Probe image", "ghcr.io/acme/tools:1"]]);
    const [note] = await api.providers.db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(note?.readAt).not.toBeNull();
  });

  it("holds a setup-command change and applies only the approved commands", async () => {
    api = await bootTestApi();
    await seedBase([]);
    const implant = "echo aW1wbGFudA== | base64 -d | sh";
    const res = await fetch(`${api.baseUrl}/api/org/sources/src_custom_tools`, {
      method: "PATCH",
      headers: REQUESTER,
      body: JSON.stringify({ setupCommands: [implant] }),
    });
    expect(res.status).toBe(202);
    const { pendingChange } = (await res.json()) as PendingSourceChangeResponse;
    expect(pendingChange.payload).toEqual({ setupCommands: [implant] });
    expect((await sourceRows())[0]?.setupCommands).toEqual([]);

    const reject = await post(`/api/org/sources/changes/${pendingChange.id}/reject`, APPROVER, { note: "unexpected encoded command" });
    expect(reject.status).toBe(200);
    expect((await sourceRows())[0]?.setupCommands).toEqual([]);
    const [stored] = await api.providers.db.select().from(imageSourceChangeRequests);
    expect(stored).toMatchObject({ status: "rejected", decidedBy: "test-admin", decisionNote: "unexpected encoded command" });
  });

  it("applies operational toggles at once", async () => {
    api = await bootTestApi();
    await seedBase();
    const res = await fetch(`${api.baseUrl}/api/org/sources/src_custom_tools`, {
      method: "PATCH",
      headers: REQUESTER,
      body: JSON.stringify({ schedule: "off" }),
    });
    expect(res.status).toBe(200);
    expect((await sourceRows())[0]?.schedule).toBe("off");
    expect(await api.providers.db.select().from(imageSourceChangeRequests)).toEqual([]);
  });

  it("refuses approval by the admin who requested the change", async () => {
    api = await bootTestApi();
    const pending = await requestExternal();
    const res = await post(`/api/org/sources/changes/${pending.id}/approve`, REQUESTER);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You requested this change. A different org admin must approve it." });
    expect(await sourceRows()).toEqual([]);
  });

  it("refuses approval, rejection, and listing for a member", async () => {
    api = await bootTestApi();
    const pending = await requestExternal();
    expect((await post(`/api/org/sources/changes/${pending.id}/approve`, MEMBER)).status).toBe(403);
    expect((await post(`/api/org/sources/changes/${pending.id}/reject`, MEMBER)).status).toBe(403);
    expect((await fetch(`${api.baseUrl}/api/org/sources/changes`, { headers: MEMBER })).status).toBe(403);
    expect(await sourceRows()).toEqual([]);
  });

  it("refuses a second pending change to the same target", async () => {
    api = await bootTestApi();
    await requestExternal("Dup");
    const res = await post("/api/org/sources", REQUESTER, { kind: "external", name: "Dup", externalRef: "ghcr.io/acme/other:1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already waits for approval\. Approve, reject, or withdraw it first\./);
  });

  it("refuses approval when the source changed after the request", async () => {
    api = await bootTestApi();
    await seedBase();
    const res = await fetch(`${api.baseUrl}/api/org/sources/src_custom_tools`, {
      method: "PATCH",
      headers: REQUESTER,
      body: JSON.stringify({ setupCommands: ["apt-get install -y jq"] }),
    });
    const { pendingChange } = (await res.json()) as PendingSourceChangeResponse;
    await api.providers.db.update(imageSources).set({ updatedAt: Date.now() + 1 }).where(eq(imageSources.id, "src_custom_tools"));
    const approve = await post(`/api/org/sources/changes/${pendingChange.id}/approve`, APPROVER);
    expect(approve.status).toBe(409);
    expect(((await approve.json()) as { error: string }).error).toMatch(/changed after this request was made\. Reject this request/);
    expect((await sourceRows())[0]?.setupCommands).toEqual([]);
  });

  it("refuses to approve a pending change to a built-in source made before built-ins were read-only", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(imageSources).values({ id: "src_default_full", orgId: "local-org", kind: "base", parentId: null, name: "default-full", externalRef: null, pullSecretName: null, setupCommands: [], profile: "full", repoHost: null, repoFullName: null, cloneUrl: null, schedule: "nightly", enabled: true, lastBoundAt: null, createdAt: now, updatedAt: now });
    await api.providers.db.insert(imageSourceChangeRequests).values({
      id: "isc_legacy", orgId: "local-org", targetKey: "src_default_full", sourceId: "src_default_full", sourceName: "default-full",
      action: "update", payload: { setupCommands: ["echo aW1wbGFudA== | base64 -d | sh"] }, baseUpdatedAt: now,
      requestedBy: "local-user", requestedAt: now, expiresAt: now + 60_000, status: "pending", decidedBy: null, decidedAt: null, decisionNote: null,
    });
    const approve = await post("/api/org/sources/changes/isc_legacy/approve", APPROVER);
    expect(approve.status).toBe(403);
    expect(((await approve.json()) as { error: string }).error).toMatch(/default-full is a built-in image source\. Reject this request/);
    expect((await sourceRows())[0]?.setupCommands).toEqual([]);
  });

  it("refuses to approve a pending create that would shadow a built-in name", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(imageSourceChangeRequests).values({
      id: "isc_shadow", orgId: "local-org", targetKey: "new:stock-full", sourceId: null, sourceName: "stock-full",
      action: "create", payload: { id: "img_shadow", orgId: "local-org", kind: "external", parentId: null, name: "stock-full", externalRef: "evil.example/img:1", pullSecretName: null, setupCommands: null, profile: null, repoHost: null, repoFullName: null, cloneUrl: null, schedule: "nightly", enabled: true, lastBoundAt: null, createdAt: now, updatedAt: now },
      baseUpdatedAt: null, requestedBy: "local-user", requestedAt: now, expiresAt: now + 60_000, status: "pending", decidedBy: null, decidedAt: null, decisionNote: null,
    });
    const approve = await post("/api/org/sources/changes/isc_shadow/approve", APPROVER);
    expect(approve.status).toBe(403);
    expect(await sourceRows()).toEqual([]);
  });

  it("refuses approval of an expired request", async () => {
    api = await bootTestApi();
    const pending = await requestExternal();
    await api.providers.db.update(imageSourceChangeRequests).set({ expiresAt: Date.now() - 1 }).where(eq(imageSourceChangeRequests.id, pending.id));
    const approve = await post(`/api/org/sources/changes/${pending.id}/approve`, APPROVER);
    expect(approve.status).toBe(409);
    expect(((await approve.json()) as { error: string }).error).toMatch(/expired\. Ask the requester to submit the change again\./);
    expect(await sourceRows()).toEqual([]);
  });

  it("lets only the requester withdraw, and refuses a decided request", async () => {
    api = await bootTestApi();
    const pending = await requestExternal();
    const other = await fetch(`${api.baseUrl}/api/org/sources/changes/${pending.id}`, { method: "DELETE", headers: APPROVER });
    expect(other.status).toBe(403);
    const own = await fetch(`${api.baseUrl}/api/org/sources/changes/${pending.id}`, { method: "DELETE", headers: REQUESTER });
    expect(own.status).toBe(200);
    const late = await post(`/api/org/sources/changes/${pending.id}/approve`, APPROVER);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("This change request is already withdrawn. Refresh the list.");
  });

  it("refuses rejection by the requester", async () => {
    api = await bootTestApi();
    const pending = await requestExternal();
    const res = await post(`/api/org/sources/changes/${pending.id}/reject`, REQUESTER);
    expect(res.status).toBe(403);
  });

  it("explains the single-admin case and names both fixes", async () => {
    api = await bootTestApi();
    await api.providers.db.delete(orgMembers).where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "test-admin")));
    const res = await post("/api/org/sources", REQUESTER, { kind: "external", name: "Solo", externalRef: "ghcr.io/acme/solo:1" });
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("this organization has one admin");
    expect(error).toContain("Add a second org admin in Settings");
    expect(error).toContain("VALET_IMAGE_SOURCE_APPROVAL=off");
    expect(await sourceRows()).toEqual([]);
    expect(await api.providers.db.select().from(imageSourceChangeRequests)).toEqual([]);
  });

  it("applies changes at once when the operator turned the gate off", async () => {
    vi.stubEnv("VALET_IMAGE_SOURCE_APPROVAL", "off");
    api = await bootTestApi();
    const res = await post("/api/org/sources", REQUESTER, { kind: "external", name: "Direct", externalRef: "ghcr.io/acme/direct:1" });
    expect(res.status).toBe(201);
    const list = await fetch(`${api.baseUrl}/api/org/sources/changes`, { headers: REQUESTER });
    expect(((await list.json()) as ListSourceChangesResponse).approval).toBe("off");
  });

  it("keeps the gate on for any value other than off", async () => {
    vi.stubEnv("VALET_IMAGE_SOURCE_APPROVAL", "of");
    api = await bootTestApi();
    await requestExternal();
  });
});
