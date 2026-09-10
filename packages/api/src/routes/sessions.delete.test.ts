/**
 * DELETE /api/sessions/:id — the assistant guard (TKAI-253).
 *
 * A user's own assistant session is not deletable: the web UI hides the
 * action, and the API is the contract, so it refuses too (the same rule
 * as the assistant move refusal). A TEAM's assistant stays deletable —
 * the session header menu is a team admin's only surface for that — and
 * a plain session keeps its normal delete.
 *
 * Deleting a team assistant's session also RETIRES the assistant row
 * (TKAI-296): archived + is_default cleared in the same transaction, so
 * the rail drops it and the team can mint a fresh default.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, assistants, teamMembers, teams } from "../schema/index.js";
import { resolveDefaultAssistant } from "../assistants/service.js";

async function seedSession(
  api: TestApi,
  opts: { id: string; owner: { type: "user" | "team"; id: string } },
): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/delete-test-${opts.id}`,
    status: "active",
    ownerType: opts.owner.type,
    ownerId: opts.owner.id,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedAssistant(
  api: TestApi,
  opts: {
    id: string;
    owner: { type: "user" | "team"; id: string };
    /** Rows migrated from orchestrator_identities keep legacy
     * `orchestrator:*` session ids — pass one to model them. */
    sessionId?: string;
  },
): Promise<void> {
  await api.providers.db.insert(assistants).values({
    id: opts.id,
    orgId: "local-org",
    ownerType: opts.owner.type,
    ownerId: opts.owner.id,
    name: null,
    personality: null,
    behavior: null,
    sessionId: opts.sessionId ?? `assistant:${opts.id}`,
    isDefault: true,
    createdAt: Date.now(),
    archivedAt: null,
  });
}

async function storedStatus(api: TestApi, sessionId: string): Promise<string | undefined> {
  const rows = await api.providers.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0]?.status;
}

function del(api: TestApi, sessionId: string) {
  return fetch(`${api.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
}

describe("DELETE /api/sessions/:id — assistant guard", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("refuses to delete the caller's own assistant session, naming the corrective action", async () => {
    api = await bootTestApi();
    await seedAssistant(api, { id: "asst_mine", owner: { type: "user", id: "local-user" } });
    await seedSession(api, {
      id: "assistant:asst_mine",
      owner: { type: "user", id: "local-user" },
    });

    const res = await del(api, "assistant:asst_mine");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cannot be deleted/i);
    expect(body.error).toMatch(/replace sandbox/i);
    expect(await storedStatus(api, "assistant:asst_mine")).toBe("active");
  });

  it("deletes a team assistant's session for a team admin", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await db.insert(teams).values({
      id: "team_del",
      orgId: "local-org",
      name: "Team del",
      origin: "local",
      externalId: null,
      createdAt: Date.now(),
    });
    await db.insert(teamMembers).values({ teamId: "team_del", userId: "local-user", role: "admin" });
    await seedAssistant(api, { id: "asst_team", owner: { type: "team", id: "team_del" } });
    await seedSession(api, {
      id: "assistant:asst_team",
      owner: { type: "team", id: "team_del" },
    });

    const res = await del(api, "assistant:asst_team");
    expect(res.status).toBe(200);
    expect(await storedStatus(api, "assistant:asst_team")).toBe("deleted");

    // TKAI-296: the delete retires the assistant row in the same
    // transaction — archived (so every rail drops it) with is_default
    // cleared (so the partial unique slot is free again).
    const retired = (
      await db.select().from(assistants).where(eq(assistants.id, "asst_team")).limit(1)
    )[0];
    expect(retired?.archivedAt).not.toBeNull();
    expect(retired?.isDefault).toBe(false);

    // The freed slot is what lets the team mint a fresh default on its
    // next access instead of resolving to the retired one.
    const fresh = await resolveDefaultAssistant(db, "local-org", {
      type: "team",
      id: "team_del",
    });
    expect(fresh.id).not.toBe("asst_team");
    expect(fresh.isDefault).toBe(true);
    expect(fresh.archivedAt).toBeNull();
  });

  it("still deletes a plain personal session", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "plain-sess", owner: { type: "user", id: "local-user" } });

    const res = await del(api, "plain-sess");
    expect(res.status).toBe(200);
    expect(await storedStatus(api, "plain-sess")).toBe("deleted");
  });

  // Rows migrated from orchestrator_identities keep legacy `orchestrator:*`
  // session ids that `parseAssistantSessionId` cannot recognize; the guard
  // and the retire must key off the assistants.session_id COLUMN, or
  // migrated assistants slip through both.
  it("refuses a migrated personal assistant with a legacy session id", async () => {
    api = await bootTestApi();
    await seedAssistant(api, {
      id: "asst_legacy_me",
      owner: { type: "user", id: "local-user" },
      sessionId: "orchestrator:user:local-user",
    });
    await seedSession(api, {
      id: "orchestrator:user:local-user",
      owner: { type: "user", id: "local-user" },
    });

    const res = await del(api, "orchestrator:user:local-user");
    expect(res.status).toBe(400);
    expect(await storedStatus(api, "orchestrator:user:local-user")).toBe("active");
  });

  it.each(["active", "deleted"] as const)("retires a migrated team assistant whose session is %s", async (status) => {
    api = await bootTestApi();
    const { db } = api.providers;
    await db.insert(teams).values({
      id: "team_legacy",
      orgId: "local-org",
      name: "Team legacy",
      origin: "local",
      externalId: null,
      createdAt: Date.now(),
    });
    await db
      .insert(teamMembers)
      .values({ teamId: "team_legacy", userId: "local-user", role: "admin" });
    await seedAssistant(api, {
      id: "asst_legacy_team",
      owner: { type: "team", id: "team_legacy" },
      sessionId: "orchestrator:team:team_legacy",
    });
    await seedSession(api, {
      id: "orchestrator:team:team_legacy",
      owner: { type: "team", id: "team_legacy" },
    });

    await db.update(agentSessions).set({ credentialOwnerMode: "actor", status })
      .where(eq(agentSessions.id, "orchestrator:team:team_legacy"));
    const destroy = vi.spyOn(api.providers.engineHost, "destroy");
    const res = await del(api, "orchestrator:team:team_legacy?retireLegacyTeam=true");
    expect(res.status).toBe(200);
    const retired = (
      await db.select().from(assistants).where(eq(assistants.id, "asst_legacy_team")).limit(1)
    )[0];
    expect(retired?.archivedAt).not.toBeNull();
    expect(retired?.isDefault).toBe(false);
    expect((await del(api, "orchestrator:team:team_legacy?retireLegacyTeam=true")).status).toBe(200);
    expect(destroy).toHaveBeenCalledTimes(4);
  });

  it("legacy cleanup refuses a plain personal chat", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "personal-kept", owner: { type: "user", id: "local-user" } });
    const res = await del(api, "personal-kept?retireLegacyTeam=true");
    expect(res.status).toBe(400);
    expect(await storedStatus(api, "personal-kept")).toBe("active");
  });

  it("legacy cleanup refuses a current team assistant", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "team_current", orgId: "local-org", name: "Current", createdAt: Date.now() });
    await seedAssistant(api, { id: "asst_current", owner: { type: "team", id: "team_current" } });
    await seedSession(api, { id: "assistant:asst_current", owner: { type: "team", id: "team_current" } });
    const res = await del(api, "assistant:asst_current?retireLegacyTeam=true");
    expect(res.status).toBe(400);
    expect(await storedStatus(api, "assistant:asst_current")).toBe("active");
  });

  it("legacy cleanup leaves an unsettled team assistant intact", async () => {
    api = await bootTestApi();
    const { db, engineStore, engineHost } = api.providers;
    const id = "assistant:asst_busy";
    await db.insert(teams).values({ id: "team_busy", orgId: "local-org", name: "Busy", createdAt: Date.now() });
    await seedAssistant(api, { id: "asst_busy", owner: { type: "team", id: "team_busy" } });
    await seedSession(api, { id, owner: { type: "team", id: "team_busy" } });
    await db.update(agentSessions).set({ credentialOwnerMode: "actor" }).where(eq(agentSessions.id, id));
    await engineHost.sessionFor(id, { userId: "local-user", orgId: "local-org", workspace: "/tmp/legacy-cleanup", ownerType: "team", ownerTeamId: "team_busy", credentialOwnerMode: "actor" });
    const now = Date.now();
    await engineStore.saveThread(id, { id: "thread_busy", sessionId: id, key: "web:thread_busy", status: "active", queueMode: "followup", createdAt: now, updatedAt: now });
    await engineStore.admitSubmission(id, "thread_busy", { id: "queued_busy", threadId: "thread_busy", content: "waiting", status: "queued", attemptCount: 0, maxAttempts: 10, timeoutAt: now + 60000, createdAt: now, updatedAt: now });
    const res = await del(api, `${id}?retireLegacyTeam=true`);
    expect(res.status).toBe(409);
    expect(await storedStatus(api, id)).toBe("active");
    const [kept] = await db.select().from(assistants).where(eq(assistants.id, "asst_busy"));
    expect(kept.archivedAt).toBeNull();
    expect(kept.isDefault).toBe(true);
  });

});
