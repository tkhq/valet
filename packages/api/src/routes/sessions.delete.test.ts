/**
 * DELETE /api/sessions/:id — the assistant guard (TKAI-253).
 *
 * A user's own assistant session is not deletable: the web UI hides the
 * action, and the API is the contract, so it refuses too (the same rule
 * as the assistant move refusal). A TEAM's assistant stays deletable —
 * the session header menu is a team admin's only surface for that — and
 * a plain session keeps its normal delete.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, assistants, teamMembers, teams } from "../schema/index.js";

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
  });

  it("still deletes a plain personal session", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "plain-sess", owner: { type: "user", id: "local-user" } });

    const res = await del(api, "plain-sess");
    expect(res.status).toBe(200);
    expect(await storedStatus(api, "plain-sess")).toBe("deleted");
  });
});
