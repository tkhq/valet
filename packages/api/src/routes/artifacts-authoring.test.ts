import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, artifacts, teamMembers, teams } from "../schema/index.js";
import { internalToken } from "../lib/internal-auth.js";
import type { ArtifactEditorResponse, ShareArtifactResponse, RequestArtifactEditResponse } from "../wire/types.js";

const json = { "content-type": "application/json" };
describe("artifact authoring API", () => {
  let api: TestApi;
  let serial = 0;
  beforeAll(async () => { api = await bootTestApi(); });
  afterAll(async () => { await api.cleanup(); });
  async function publish(content = "# Plan\n\nBefore. Change this. After.", headers: Record<string, string> = {}, query = "") {
    const response = await fetch(`${api.baseUrl}/api/artifacts/share${query}`, {
      method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ key: `authoring-${++serial}`, content }),
    });
    expect(response.status).toBe(200);
    return await response.json() as ShareArtifactResponse;
  }
  const url = (id: string, suffix: string) => `${api.baseUrl}/api/artifacts/${id}/${suffix}`;
  const post = (id: string, suffix: string, body: unknown, headers: Record<string, string> = {}) => fetch(url(id, suffix), {
    method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body),
  });
  async function source() {
    const res = await fetch(`${api.baseUrl}/api/sessions`, { method: "POST", headers: json, body: JSON.stringify({ workspace: "/tmp" }) });
    expect(res.status).toBe(201);
    const session = await res.json() as { id: string };
    const threadResponse = await fetch(`${api.baseUrl}/api/sessions/${session.id}/threads`, { method: "POST", headers: json, body: "{}" });
    expect(threadResponse.status).toBe(201);
    const thread = await threadResponse.json() as { id: string };
    return { "x-valet-session-id": session.id, "x-valet-thread-id": thread.id };
  }

  it("serves protected working/history snapshots and restores without changing the shared pin", async () => {
    const shared = await publish();
    const originalResponse = await fetch(url(shared.id, "editor"));
    expect(originalResponse.status).toBe(200);
    const original = await originalResponse.json() as ArtifactEditorResponse;
    expect(original).toMatchObject({ version: 1, content: "# Plan\n\nBefore. Change this. After.", canEdit: false });
    await fetch(`${api.baseUrl}/api/artifacts/share`, { method: "POST", headers: json, body: JSON.stringify({ key: shared.path, content: "# Second" }) });
    await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ sharedVersion: 1 }) });
    const history = await (await fetch(url(shared.id, "editor?version=1"))).json() as ArtifactEditorResponse;
    expect(history).toMatchObject({ version: 1, content: original.content, artifact: { version: 2, sharedVersion: 1 } });
    const restoredResponse = await post(shared.id, "restore", { version: 1, baseVersion: 2 });
    expect(restoredResponse.status).toBe(200);
    expect(await restoredResponse.json()).toMatchObject({ version: 3, content: original.content, artifact: { version: 3, sharedVersion: 1, token: original.artifact.token } });
    expect((await post(shared.id, "restore", { version: 2, baseVersion: 2 })).status).toBe(409);
    expect((await fetch(url(shared.id, "editor?version=0"))).status).toBe(400);
    expect((await fetch(url(shared.id, "editor?version=999"))).status).toBe(404);
    expect((await fetch(url(shared.id, "editor"), { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(403);
  });

  it("persists and delivers a bounded edit to its source thread and applies it through verified owner scope", async () => {
    const sourceHeaders = await source();
    const shared = await publish(undefined, sourceHeaders);
    expect(await (await fetch(url(shared.id, "editor"))).json()).toMatchObject({ canEdit: true, sourceSessionId: sourceHeaders["x-valet-session-id"], sourceThreadId: sourceHeaders["x-valet-thread-id"] });
    const requested = await post(shared.id, "edit-requests", { baseVersion: 1, instruction: "Make the selected text clearer", selection: { text: "Change this." } });
    expect(requested.status).toBe(200);
    const request = await requested.json() as RequestArtifactEditResponse;
    expect(request.sent).toBe(true);
    const submissions = [
      ...await api.providers.engineStore.listUnsettledSubmissions(sourceHeaders["x-valet-session-id"]),
      ...await api.providers.engineStore.listSettledSubmissionsBefore(sourceHeaders["x-valet-session-id"], Date.now() + 1),
    ];
    const submitted = submissions.find(item => JSON.stringify(item.content).includes(request.requestId));
    expect(submitted?.threadId).toBe(sourceHeaders["x-valet-thread-id"]);
    expect(JSON.stringify(submitted?.content)).toContain("artifact_edit");
    expect(JSON.stringify(submitted?.content)).toContain("Edit the selection in **Plan** (version 1)");
    expect(JSON.stringify(submitted?.content)).toContain("[valet-artifact-edit-context]: #");
    expect(JSON.stringify(submitted?.content)).toContain("Make the selected text clearer");
    expect((await post(shared.id, "apply-edit", { requestId: request.requestId, replacement: "Changed." })).status).toBe(403);
    const toolHeaders = { ...sourceHeaders, "x-valet-internal": internalToken(), "x-valet-owner": "user:local-user", "x-valet-actor": "local-user", "x-valet-org-id": "local-org" };
    const applied = await post(shared.id, "apply-edit", { requestId: request.requestId, replacement: "Changed." }, toolHeaders);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ version: 2, content: "# Plan\n\nBefore. Changed. After." });
    expect((await post(shared.id, "edit-requests", { baseVersion: 1, instruction: "Again", selection: { text: "Changed." } })).status).toBe(409);
  });

  it("rejects team helper provenance that the manager cannot open", async () => {
    await api.providers.db.insert(teams).values({ id: "authoring-team", orgId: "local-org", name: "Team", createdAt: 1 });
    await api.providers.db.insert(teamMembers).values([
      { teamId: "authoring-team", userId: "local-user", role: "admin" }, { teamId: "authoring-team", userId: "test-member", role: "member" },
    ]);
    await api.providers.db.insert(agentSessions).values({ id: "private-source", userId: "test-member", orgId: "local-org", ownerType: "team", ownerId: "authoring-team", workspace: "/tmp", createdAt: 1, updatedAt: 1 });
    await api.providers.engineStore.saveThread("private-source", { id: "private-helper", sessionId: "private-source", key: "app-assistant:test-member", status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
    const shared = await publish(undefined, { "x-valet-test-user-id": "test-member", "x-valet-session-id": "private-source", "x-valet-thread-id": "private-helper" }, "?ownerType=team&ownerId=authoring-team");
    expect((await fetch(url(shared.id, "editor"))).status).toBe(404);
    expect((await post(shared.id, "restore", { version: 1, baseVersion: 1 })).status).toBe(404);
    expect((await post(shared.id, "edit-requests", { baseVersion: 1, instruction: "Change", selection: { text: "Change this." } })).status).toBe(404);
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.userId, "test-member"));
    expect((await fetch(url(shared.id, "editor"), { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    expect((await api.providers.db.select().from(artifacts).where(eq(artifacts.id, shared.id)))[0].version).toBe(1);
  });
  it("keeps working source out of ordinary comments when the shared revision is pinned", async () => {
    const sourceHeaders = await source();
    const shared = await publish("# Plan\n\nShared revision", sourceHeaders);
    await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ sharedVersion: 1 }) });
    await fetch(`${api.baseUrl}/api/artifacts/share`, { method: "POST", headers: { ...json, ...sourceHeaders }, body: JSON.stringify({ key: shared.path, content: "# Plan\n\nPrivate working draft" }) });
    const response = await post(shared.id, "edit-requests", { baseVersion: 2, instruction: "Shorten this", selection: { text: "Private working draft" } });
    expect(response.status).toBe(200);
    const token = new URL(shared.url).pathname.split("/").at(-1);
    const publicRead = await (await fetch(`${api.baseUrl}/api/artifacts/${token}`)).json();
    expect(publicRead).toMatchObject({ version: 1, content: "# Plan\n\nShared revision" });
    for (const endpoint of [`${token}/comments`, `${shared.id}/comment-threads`]) {
      const comments = await fetch(`${api.baseUrl}/api/artifacts/${endpoint}`);
      expect(comments.status).toBe(200);
      expect(await comments.text()).not.toContain("Private working draft");
    }
  });

  it("hides another publisher's historical body after a team key changes publisher and source", async () => {
    await api.providers.db.insert(teamMembers).values({ teamId: "authoring-team", userId: "test-member", role: "member" }).onConflictDoNothing();
    const original = await publish("# Private history\n\nSecret prior helper draft.", {
      "x-valet-test-user-id": "test-member", "x-valet-session-id": "private-source", "x-valet-thread-id": "private-helper",
    }, "?ownerType=team&ownerId=authoring-team");
    // The team publication API keeps its existing collaborative key semantics.
    const refresh = await fetch(`${api.baseUrl}/api/artifacts/share?ownerType=team&ownerId=authoring-team`, {
      method: "POST", headers: { ...json, "x-valet-source": "none" }, body: JSON.stringify({ key: original.path, content: "# Current shared draft" }),
    });
    expect(refresh.status).toBe(200);
    expect((await fetch(url(original.id, "editor"))).status).toBe(200);
    expect((await fetch(url(original.id, "editor?version=1"))).status).toBe(404);
    expect((await post(original.id, "restore", { version: 1, baseVersion: 2 })).status).toBe(404);
    expect((await api.providers.db.select().from(artifacts).where(eq(artifacts.id, original.id)))[0].version).toBe(2);
  });

  it("keeps legacy artifacts without a linked thread in preview and restore mode", async () => {
    const sourceHeaders = await source();
    const shared = await publish(undefined, { "x-valet-session-id": sourceHeaders["x-valet-session-id"] });
    const response = await fetch(url(shared.id, "editor"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canEdit: false });
    const request = await post(shared.id, "edit-requests", { baseVersion: 1, instruction: "Change", selection: { text: "Change this." } });
    expect(request.status).toBe(400);
    expect(await request.text()).toContain("Create a new artifact");
    expect((await post(shared.id, "restore", { version: 1, baseVersion: 1 })).status).toBe(200);
  });

});
