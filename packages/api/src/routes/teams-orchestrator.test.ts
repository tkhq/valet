/**
 * `POST /api/teams/:id/orchestrator` — get-or-create the team's
 * orchestrator session (`services/session-access.ts`'s companion route:
 * this creates the `agent_sessions` row that route widens read access to).
 * Mirrors `POST /api/orchestrator`'s own contract for the user case.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, teamMembers, teams } from "../schema/index.js";
import type { EnsureOrchestratorResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("POST /api/teams/:id/orchestrator", () => {
  it("creates the team's orchestrator session for a member and returns its id", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await api.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "member" });

    const res = await fetch(`${api.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnsureOrchestratorResponse;
    expect(body.sessionId).toBe("orchestrator:team:team_1");

    const rows = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, body.sessionId));
    expect(rows[0]?.ownerType).toBe("team");
    expect(rows[0]?.ownerId).toBe("team_1");
  });

  it("is idempotent — a second call returns the same session id, doesn't duplicate the row", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await api.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "member" });

    const first = (await (await fetch(`${api.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST" })).json()) as EnsureOrchestratorResponse;
    const second = (await (await fetch(`${api.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST" })).json()) as EnsureOrchestratorResponse;
    expect(second.sessionId).toBe(first.sessionId);

    const rows = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, first.sessionId));
    expect(rows).toHaveLength(1);
  });

  it("lets an org admin reach a team's orchestrator without being a direct member — same rule GET /:id/members already uses", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_2", orgId: "local-org", name: "Other Team", createdAt: now });
    // No team_members row for local-user — it's an org admin (seeded by
    // bootTestApi), which `canViewTeam` already treats as a recovery path
    // for every team in the org, not just ones the caller is on.

    const res = await fetch(`${api.baseUrl}/api/teams/team_2/orchestrator`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("404s for a team in a different org", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_3", orgId: "other-org", name: "Elsewhere", createdAt: now });

    const res = await fetch(`${api.baseUrl}/api/teams/team_3/orchestrator`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("404s for an unknown team id", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/teams/no-such-team/orchestrator`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:id — team view access", () => {
  it("lets a team member view a team-owned session created via the orchestrator route", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await api.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "member" });

    const created = (await (await fetch(`${api.baseUrl}/api/teams/team_1/orchestrator`, { method: "POST" })).json()) as EnsureOrchestratorResponse;

    const res = await fetch(`${api.baseUrl}/api/sessions/${created.sessionId}`);
    expect(res.status).toBe(200);
  });

  it("still 404s a session directly owned by someone else", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: "sess_someone_else",
      userId: "test-member",
      orgId: "local-org",
      workspace: "/tmp",
      status: "active",
      ownerType: "user",
      ownerId: "test-member",
      createdAt: now,
      updatedAt: now,
    });

    const res = await fetch(`${api.baseUrl}/api/sessions/sess_someone_else`);
    expect(res.status).toBe(404);
  });
});
