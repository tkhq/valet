import { describe, expect, it } from "vitest";
import { filterTeamKeysFromPersonalApiKeyList } from "./personal-api-key-list.js";

const LIST_PATH = "/api/auth/api-key/list";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("filterTeamKeysFromPersonalApiKeyList", () => {
  it("drops team-pinned rows and recomputes total so the count cannot leak them", async () => {
    const res = jsonResponse({
      apiKeys: [
        { id: "k1", metadata: { teamId: "team_1", createdBy: "u1" } },
        { id: "k2", metadata: null },
        { id: "k3", metadata: { teamId: "team_2" } },
      ],
      total: 3,
    });
    const out = await filterTeamKeysFromPersonalApiKeyList(LIST_PATH, res);
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ apiKeys: [{ id: "k2", metadata: null }], total: 1 });
  });

  it("passes every other path through untouched", async () => {
    const res = jsonResponse({ apiKeys: [{ id: "k1", metadata: { teamId: "team_1" } }], total: 1 });
    const out = await filterTeamKeysFromPersonalApiKeyList("/api/auth/api-key/get", res);
    expect(out).toBe(res);
  });

  it("fails closed when the list shape is not the one it knows", async () => {
    // An upgraded better-auth that renames `apiKeys` would otherwise ship
    // every team key to the personal list unfiltered.
    const res = jsonResponse({ keys: [{ id: "k1", metadata: { teamId: "team_1" } }] });
    const out = await filterTeamKeysFromPersonalApiKeyList(LIST_PATH, res);
    expect(out.status).toBe(500);
    expect(((await out.json()) as { error: string }).error).toContain("api-key");
  });
});
