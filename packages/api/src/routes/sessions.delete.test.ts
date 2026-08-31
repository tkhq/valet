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
import { describe, it, expect, afterEach } from "vitest";
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
  opts: { id: string; owner: { type: "user" | "team"; id: string } },
): Promise<void> {
  await api.providers.db.insert(assistants).values({
    id: opts.id,
    orgId: "local-org",
    ownerType: opts.owner.type,
    ownerId: opts.owner.id,
    name: null,
    personality: null,
    behavior: null,
    sessionId: `assistant:${opts.id}`,
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
});
