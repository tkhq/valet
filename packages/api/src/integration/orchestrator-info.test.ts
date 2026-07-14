/**
 * Integration tests for the assistant-identity endpoints (assistant-centered
 * web UI Task 2, decisions 4/5/6/20):
 *
 *   - GET  /api/orchestrator/info    — never creates; presence derivation.
 *   - PATCH /api/orchestrator/info   — works before the engine session
 *     exists; name -> orchestrator_identities.handle; personality -> the
 *     assistant/personality.md memory file; evicts the cached engine
 *     session (cache-only, never the destructive `session.destroy()`).
 *   - GET  /api/orchestrator/children — child_watches ⋈ agent_sessions.
 *   - Persona injection (decision 5): after a PATCH rename, the next wake's
 *     `systemPrompt` contains the name and personality, AND the pre-existing
 *     transcript survives (proves eviction, not destruction).
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { agentSessions, childWatches, orchestratorIdentities } from "../schema/index.js";
import { addMember, createTeam } from "../services/teams.js";
import { writeFile } from "../services/memory.js";
import type {
  EnsureOrchestratorResponse,
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse,
  PatchOrchestratorInfoResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const ORCH_SESSION_ID = "orchestrator:user:local-user";

describe("GET /api/orchestrator/info", () => {
  it("never creates: reports name/personality null and presence idle before any ensure", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetOrchestratorInfoResponse;
    expect(body).toEqual({
      sessionId: ORCH_SESSION_ID,
      name: null,
      personality: null,
      presence: "idle",
      activeChildren: 0,
    });

    // Never creates — no identity row, no agent_sessions row.
    const identityRows = await api.providers.db.select().from(orchestratorIdentities).all();
    expect(identityRows).toHaveLength(0);
  });

  it("presence is 'working' when child_watches has an unsettled row for this orchestrator", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const now = Date.now();
    await db
      .insert(childWatches)
      .values({
        childSessionId: "child-1",
        queueItemId: "qi-1",
        parentSessionId: ORCH_SESSION_ID,
        parentThreadId: "th-1",
        actorUserId: "local-user",
        orgId: "local-org",
        settled: 0,
        createdAt: now,
      })
      .run();

    const res = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    const body = (await res.json()) as GetOrchestratorInfoResponse;
    expect(body.presence).toBe("working");
    expect(body.activeChildren).toBe(1);
  });

  it("does not leak a team's assistant/personality.md into a member's own persona/info (own-scope read only)", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    // local-user is a member of Platform, which has its own
    // assistant/personality.md. local-user has never written a personal
    // one. Personality reads (GET /info and persona injection) must go
    // through an own-scope-only lookup, not `readFile`'s team read-union
    // (which is correct/intentional for the memory explorer, but wrong for
    // a per-user persona/identity field).
    const team = await createTeam(db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await addMember(db, { teamId: team.id, userId: "local-user", role: "member" });
    await writeFile(db, { owner: { type: "team", id: team.id }, actorUserId: "local-user" }, {
      path: "assistant/personality.md",
      content: "Team-wide corporate voice.",
    });

    const infoRes = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    expect(infoRes.status).toBe(200);
    const infoBody = (await infoRes.json()) as GetOrchestratorInfoResponse;
    expect(infoBody.personality).toBeNull();

    // Set a name (no personal personality) and confirm the persona prefix
    // that gets injected into systemPrompt stays neutral — no team content.
    const patchRes = await fetch(`${api.baseUrl}/api/orchestrator/info`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wren" }),
    });
    expect(patchRes.status).toBe(200);

    const session = await api.providers.engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.systemPrompt).toContain("You are Wren.\n\n");
    expect(session.options.systemPrompt).not.toContain("Team-wide corporate voice.");
  });

  it("settled child_watches rows don't count toward activeChildren/presence", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    await db
      .insert(childWatches)
      .values({
        childSessionId: "child-1",
        queueItemId: "qi-1",
        parentSessionId: ORCH_SESSION_ID,
        parentThreadId: "th-1",
        actorUserId: "local-user",
        orgId: "local-org",
        settled: 1,
        createdAt: Date.now(),
      })
      .run();

    const res = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    const body = (await res.json()) as GetOrchestratorInfoResponse;
    expect(body.presence).toBe("idle");
    expect(body.activeChildren).toBe(0);
  });
});

describe("PATCH /api/orchestrator/info", () => {
  it("upserts the identity row and writes the personality memory file BEFORE the engine session exists", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    // No ensure has happened — no agent_sessions row for the orchestrator id.
    const patchRes = await fetch(`${api.baseUrl}/api/orchestrator/info`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wren", personality: "Warm and direct." }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as PatchOrchestratorInfoResponse;
    expect(patchBody).toEqual({ ok: true });

    const identityRows = await db
      .select()
      .from(orchestratorIdentities)
      .where(eq(orchestratorIdentities.sessionId, ORCH_SESSION_ID))
      .all();
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0]?.handle).toBe("Wren");

    const infoRes = await fetch(`${api.baseUrl}/api/orchestrator/info`);
    const infoBody = (await infoRes.json()) as GetOrchestratorInfoResponse;
    expect(infoBody.name).toBe("Wren");
    expect(infoBody.personality).toBe("Warm and direct.");

    // The memory file is visible through the ordinary memory route too.
    const memRes = await fetch(`${api.baseUrl}/api/memory?path=assistant/personality.md`);
    expect(memRes.status).toBe(200);
    const memBody = (await memRes.json()) as { kind: string; file: { content: string; pinned: number; origin: string } };
    expect(memBody.kind).toBe("file");
    expect(memBody.file.content).toBe("Warm and direct.");
    expect(memBody.file.pinned).toBe(0);
    expect(memBody.file.origin).toBe("user-stated");
  });

  it("a second PATCH updates the existing identity row rather than inserting a second one", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    await fetch(`${api.baseUrl}/api/orchestrator/info`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wren" }),
    });
    await fetch(`${api.baseUrl}/api/orchestrator/info`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Atlas" }),
    });

    const rows = await db
      .select()
      .from(orchestratorIdentities)
      .where(eq(orchestratorIdentities.sessionId, ORCH_SESSION_ID))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.handle).toBe("Atlas");
  });

  it("evicts the cache (not destroy): the engine session row survives a PATCH after ensure", async () => {
    api = await bootTestApi();

    const ensureRes = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
    const { sessionId } = (await ensureRes.json()) as EnsureOrchestratorResponse;
    expect(api.providers.engineHost.isLive(sessionId)).toBe(true);

    const patchRes = await fetch(`${api.baseUrl}/api/orchestrator/info`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wren" }),
    });
    expect(patchRes.status).toBe(200);

    // Cache dropped...
    expect(api.providers.engineHost.isLive(sessionId)).toBe(false);
    // ...but the underlying engine session row was never deleted (destroy()
    // would have removed it) — a fresh wake restores, not creates.
    const restored = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/irrelevant",
    });
    expect(restored.id).toBe(sessionId);
  });
});

describe("GET /api/orchestrator/children", () => {
  it("lists child_watches rows joined to their agent_sessions title, newest first", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const now = Date.now();
    await db
      .insert(agentSessions)
      .values([
        {
          id: "child-a",
          userId: "local-user",
          orgId: "local-org",
          workspace: "/tmp/child-a",
          title: "Fix the bug",
          status: "active",
          ownerType: "user",
          ownerId: "local-user",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "child-b",
          userId: "local-user",
          orgId: "local-org",
          workspace: "/tmp/child-b",
          title: "Research thing",
          status: "active",
          ownerType: "user",
          ownerId: "local-user",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    await db
      .insert(childWatches)
      .values([
        {
          childSessionId: "child-a",
          queueItemId: "qi-a",
          parentSessionId: ORCH_SESSION_ID,
          parentThreadId: "th-1",
          actorUserId: "local-user",
          orgId: "local-org",
          settled: 1,
          createdAt: now,
        },
        {
          childSessionId: "child-b",
          queueItemId: "qi-b",
          parentSessionId: ORCH_SESSION_ID,
          parentThreadId: "th-1",
          actorUserId: "local-user",
          orgId: "local-org",
          settled: 0,
          createdAt: now + 1,
        },
      ])
      .run();

    const res = await fetch(`${api.baseUrl}/api/orchestrator/children`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetOrchestratorChildrenResponse;

    expect(body.children).toHaveLength(2);
    // Newest first.
    expect(body.children[0]).toMatchObject({
      sessionId: "child-b",
      title: "Research thing",
      parentThreadId: "th-1",
      status: "running",
    });
    expect(body.children[1]).toMatchObject({
      sessionId: "child-a",
      title: "Fix the bug",
      parentThreadId: "th-1",
      status: "settled",
    });
  });

  it("only returns children watched by the caller's own orchestrator", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const now = Date.now();
    await db
      .insert(agentSessions)
      .values({
        id: "other-child",
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/other-child",
        title: "Someone else's child",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(childWatches)
      .values({
        childSessionId: "other-child",
        queueItemId: "qi-other",
        parentSessionId: "orchestrator:user:someone-else",
        parentThreadId: "th-1",
        actorUserId: "someone-else",
        orgId: "local-org",
        settled: 0,
        createdAt: now,
      })
      .run();

    const res = await fetch(`${api.baseUrl}/api/orchestrator/children`);
    const body = (await res.json()) as GetOrchestratorChildrenResponse;
    expect(body.children).toHaveLength(0);
  });
});

describe("Persona injection (decision 5): rename + personality survive a wake, transcript preserved", () => {
  it("system prompt contains the new name and personality after a PATCH-triggered eviction, and the pre-existing transcript is intact", async () => {
    api = await bootTestApi();
    const { engineHost, engineStore } = api.providers;

    // Ensure the orchestrator, seed a transcript entry directly (no LLM
    // call needed — same pattern as messages.signal.test.ts).
    const ensureRes = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
    const { sessionId } = (await ensureRes.json()) as EnsureOrchestratorResponse;

    const before = await engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    // No name yet — neutral persona (the un-prefixed persona body itself
    // legitimately starts with "You are this person's..." — assert the
    // *named* prefix is absent, not the substring "You are").
    expect(before.options.systemPrompt).not.toContain("You are Wren");

    const thread = await before.ensureDefaultThread();
    await engineStore.appendEntries(sessionId, thread.id, [
      {
        id: "e-preexisting",
        sessionId,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "hello before the rename",
        createdAt: Date.now(),
      },
    ]);

    const patchRes = await fetch(`${api.baseUrl}/api/orchestrator/info`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wren", personality: "Warm and direct." }),
    });
    expect(patchRes.status).toBe(200);
    expect(engineHost.isLive(sessionId)).toBe(false);

    const after = await engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(after.options.systemPrompt).toContain("You are Wren. Warm and direct.");

    const entries = (await after.readEntries("web:default")) ?? [];
    expect(entries.some((e) => e.id === "e-preexisting")).toBe(true);
  });
});
