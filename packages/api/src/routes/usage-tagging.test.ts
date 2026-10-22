import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { externalCalls, orgs, teams, teamMembers } from "../schema/index.js";
import { eq } from "drizzle-orm";
import { Tagger } from "../tagging/tagger.js";
import { toolIntentDimension } from "../tagging/tool-intent.js";
import type { ExternalUsageResponse } from "../wire/types.js";
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

describe("intent usage scope and registry administration", () => {
  it("filters keys, top tools, and feed by key, surface, and authorized ownership", async () => {
    api = await bootTestApi(); const db = api.providers.db;
    await db.update(orgs).set({ features: { organizations: true } }).where(eq(orgs.id, "local-org"));
    await db.insert(teams).values({ id: "team", orgId: "local-org", name: "Team", createdAt: Date.now() });
    await db.insert(teamMembers).values([{ teamId: "team", userId: "local-user", role: "admin" }, { teamId: "team", userId: "test-member", role: "member" }]);
    const rows = [
      { id: "mine", userId: "local-user", surface: "mcp" as const, ownerType: "user" as const, ownerId: "local-user" },
      { id: "theirs", userId: "test-member", surface: "hosted" as const, ownerType: "team" as const, ownerId: "team" },
      { id: "foreign", userId: "local-user", surface: "mcp" as const, ownerType: "user" as const, ownerId: "local-user" },
    ];
    await db.insert(externalCalls).values(rows.map(row => ({ ...row, orgId: row.id === "foreign" ? "other-org" : "local-org", name: "call_tool", intent: "Review code to find a bug.", outcome: "ok" as const, durationMs: 1, createdAt: Date.now() })));
    const tagger = new Tagger({ db, orgId: "local-org", dimensions: [toolIntentDimension], renderers: new Map(), classify: async () => ({ text: JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "code_review", confidence: 1 }] }, { index: 1, labels: [{ key: "new_purpose", confidence: 1 }] }], newKeys: [{ key: "new_purpose", label: "New purpose", definition: "A distinct purpose." }] }), model: "test" }) });
    await tagger.tag("tool_intent", rows.slice(0, 2).map(row => ({ type: "external_call", text: "Review code to find a bug.", ...row })));
    const read = async (query: string, userId?: string) => {
      const res = await fetch(`${api!.baseUrl}/api/usage/external?window=7d${query}`, { headers: userId ? { "x-valet-test-user-id": userId } : {} });
      expect(res.status).toBe(200); return await res.json() as ExternalUsageResponse;
    };
    const mine = await read("");
    expect(mine.classification?.keys.find(key => key.key === "code_review")?.calls).toBe(1);
    expect(mine.classification?.keys.find(key => key.key === "new_purpose")?.calls).toBe(0);
    expect(mine.tools).toEqual([expect.objectContaining({ key: "code_review", calls: 1 })]);
    const all = await read("&scope=org&surface=hosted&key=__emerging");
    expect(all.recent.map(row => row.id)).toEqual(["theirs"]);
    expect(all.tools).toEqual([expect.objectContaining({ key: "new_purpose" })]);
    const member = await read("&scope=team&teamId=team", "test-member");
    expect(member.recent).toEqual([]); expect(member.classification?.canManage).toBe(false);
    expect(member.classification?.keys.find(key => key.key === "new_purpose")?.calls).toBe(1);
    await tagger.registry.merge("tool_intent", "code_review", "debug_investigate");
    expect((await read("&key=debug_investigate")).recent[0]?.key).toBe("debug_investigate");
    expect((await read("&key=code_review")).recent).toEqual([]);
  });
  it("allows only org settings admins to edit or merge registry keys", async () => {
    api = await bootTestApi();
    await fetch(`${api.baseUrl}/api/usage/external?window=7d`);
    const change = async (user: string, path: string, body: unknown, method = "PATCH") => fetch(`${api!.baseUrl}/api/org/tag-keys/tool_intent/${path}`, { method, headers: { "Content-Type": "application/json", "x-valet-test-user-id": user }, body: JSON.stringify(body) });
    expect((await change("test-member", "code_change", { label: "Changed", definition: "A definition." })).status).toBe(403);
    expect((await change("local-user", "code_change", { label: "Changes", definition: "Implementation work." })).status).toBe(200);
    expect((await change("local-user", "code_change/merge", { into: "code_review" }, "POST")).status).toBe(200);
    expect((await change("local-user", "other/merge", { into: "code_review" }, "POST")).status).toBe(400);
  });
});
