import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { briefingDismissals, sessionThreads, teamMembers, teams, workspaceBriefingCache } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("retires briefing reads and dismissals without changing retained data or threads", async () => {
  api = await bootTestApi();
  const created = await fetch(`${api.baseUrl}/api/threads`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const thread = await created.json() as { id: string; sessionId: string };
  await api.providers.db.insert(sessionThreads).values({ id: thread.id, sessionId: thread.sessionId, createdAt: 1 })
    .onConflictDoNothing();
  await api.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Engineering", createdAt: 1 });
  await api.providers.db.insert(teamMembers).values({ teamId: "team-1", userId: "local-user", role: "member" });
  const briefingId = `brief:${"a".repeat(24)}`;
  const response = { briefings: [{ id: briefingId, title: "Retained brief", summary: "Retained summary.", status: "updated" as const,
    updatedAt: 1, latestThread: { sessionId: thread.sessionId, threadId: thread.id }, sources: [] }], generatedAt: 1, coverage: "recent" as const };
  await api.providers.db.insert(workspaceBriefingCache).values({
    orgId: "local-org", ownerType: "user", ownerId: "local-user", version: "retained", response,
  });
  await api.providers.db.insert(briefingDismissals).values({ userId: "local-user", orgId: "local-org", ownerType: "user",
    ownerId: "local-user", briefingId: "run:retained-failure", dismissedAt: 1 });

  const dismiss = await fetch(`${api.baseUrl}/api/workspaces/user/briefings/${briefingId}/dismiss`, { method: "POST" });
  expect(dismiss.status).toBe(404);
  for (const scope of ["user", "team-1"]) {
    expect((await fetch(`${api.baseUrl}/api/workspaces/${scope}/briefings`)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/workspaces/${scope}/briefings/${briefingId}/dismiss`, { method: "POST" })).status).toBe(404);
  }

  const [cached] = await api.providers.db.select().from(workspaceBriefingCache);
  expect(cached).toMatchObject({ version: "retained", response, leaseToken: null, leaseUntil: 0 });
  const [metadata] = await api.providers.db.select().from(sessionThreads).where(eq(sessionThreads.id, thread.id));
  expect(metadata).toMatchObject({ id: thread.id, sessionId: thread.sessionId, archivedAt: null });
  const dismissals = await api.providers.db.select().from(briefingDismissals);
  expect(dismissals.map(row => row.briefingId)).toEqual(["run:retained-failure"]);
});
