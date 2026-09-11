import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createTeam, addMember } from "../services/teams.js";
import { skills, teamDeletionRequests } from "../schema/index.js";
import { encodePageCursor } from "../lib/page-cursor.js";
import type { ListTeamDeletionRequestsResponse } from "../wire/types.js";

let api: TestApi;
let sequence = 0;
beforeAll(async () => { api = await bootTestApi(); });
afterAll(async () => { await api?.cleanup(); });
async function fixture() {
  const team = await createTeam(api.providers.db, { orgId: "local-org", name: `Pagination ${++sequence}`, creatorUserId: "local-user" });
  await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
  return team.id;
}
function list(teamId: string, query = "", userId = "local-user") {
  return fetch(`${api.baseUrl}/api/teams/${teamId}/deletion-requests${query}`, { headers: { "x-valet-test-user-id": userId } });
}
function row(teamId: string, id: string, status: "pending" | "withdrawn", at: number) {
  return { id: `${teamId}-${id}`, orgId: "local-org", teamId, resourceType: "skill" as const, resourceId: `${teamId}-${id}`,
    resourceLabel: id, requestedBy: "test-member", requestedAt: at, expiresAt: Date.now() + 86400000, status };
}
async function page(teamId: string, query = "") {
  const response = await list(teamId, query);
  expect(response.status).toBe(200);
  return await response.json() as ListTeamDeletionRequestsResponse;
}

describe("deletion request pagination", () => {
  it("exposes an oldest pending request after 100 newer closed requests and a duplicate submission", async () => {
    const teamId = await fixture();
    const oldest = row(teamId, "oldest", "pending", 1);
    await api.providers.db.insert(skills).values({ id: oldest.resourceId, orgId: "local-org", ownerType: "team", ownerId: teamId,
      name: "Oldest", origin: "local", content: "fixture", contentSha: "fixture", description: "fixture", createdAt: 1, updatedAt: 1 });
    await api.providers.db.insert(teamDeletionRequests).values([oldest, ...Array.from({ length: 100 }, (_, i) => row(teamId, `closed-${i}`, "withdrawn", i + 2))]);
    const all = await page(teamId);
    expect(all.requests).toHaveLength(100);
    expect(all.nextCursor).toBeTruthy();
    const next = await page(teamId, `?cursor=${encodeURIComponent(all.nextCursor ?? "")}`);
    expect(next.requests.map((r) => r.id)).toEqual([oldest.id]);
    expect(next.nextCursor).toBeNull();
    const duplicate = await fetch(`${api.baseUrl}/api/teams/${teamId}/deletion-requests`, { method: "POST",
      headers: { "content-type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ resourceType: "skill", resourceId: oldest.resourceId }) });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ created: false, request: { id: oldest.id } });
    expect((await page(teamId, "?status=pending")).requests.map((r) => r.id)).toEqual([oldest.id]);
  });

  it("reaches every pending request beyond 100 with tied timestamps, even after the cursor row is deleted", async () => {
    const teamId = await fixture();
    const expected = Array.from({ length: 105 }, (_, i) => row(teamId, `pending-${String(i).padStart(3, "0")}`, "pending", 10));
    const expired = { ...row(teamId, "expired", "pending", 11), expiresAt: 1 };
    await api.providers.db.insert(teamDeletionRequests).values([...expected, expired]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await page(teamId, `?status=pending&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(result.requests.length).toBeLessThanOrEqual(50);
      seen.push(...result.requests.map((r) => r.id));
      if (!cursor) {
        const boundary = result.requests.at(-1);
        if (!boundary) throw new Error("Expected first page");
        await api.providers.db.delete(teamDeletionRequests).where(eq(teamDeletionRequests.id, boundary.id));
      }
      cursor = result.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(105);
    expect(new Set(seen)).toEqual(new Set(expected.map((r) => r.id)));
    const history = await page(teamId, "?status=history");
    expect(history.requests.map((r) => [r.id, r.status])).toEqual([[expired.id, "expired"]]);
  });

  it("validates limits, filters and scoped cursors without relaxing tenant or membership access", async () => {
    const teamId = await fixture();
    const otherTeamId = await fixture();
    await api.providers.db.insert(teamDeletionRequests).values([row(teamId, "one", "pending", 10), row(teamId, "two", "pending", 10), row(otherTeamId, "private", "pending", 10)]);
    const first = await page(teamId, "?status=pending&limit=1");
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    for (const query of ["?status=unknown", "?limit=0", "?limit=1.5", "?limit=abc", "?cursor=", "?cursor=broken",
      `?status=history&cursor=${cursor}`, `?cursor=${encodePageCursor({ orgId: "other-org", teamId, status: "all", at: 10, id: "one" })}`,
      `?cursor=${encodePageCursor({ orgId: "local-org", teamId, status: "all", at: "10", id: "one" })}`]) {
      expect((await list(teamId, query)).status).toBe(400);
    }
    expect((await list(otherTeamId, `?status=pending&cursor=${cursor}`)).status).toBe(400);
    // A forged sort key is not authority: every page still scopes its SQL.
    const forged = encodePageCursor({ orgId: "local-org", teamId, status: "all", at: 100, id: "anything" });
    expect((await page(teamId, `?cursor=${forged}`)).requests.every((r) => r.teamId === teamId)).toBe(true);
    expect((await list(teamId, `?status=pending&cursor=${cursor}`, "test-admin")).status).toBe(200);
    const hidden = await createTeam(api.providers.db, { orgId: "local-org", name: "Hidden", creatorUserId: "local-user" });
    expect((await list(hidden.id, `?status=pending&cursor=${cursor}`, "test-member")).status).toBe(404);
    expect((await page(teamId, "?limit=999")).requests).toHaveLength(2);
  });
});
