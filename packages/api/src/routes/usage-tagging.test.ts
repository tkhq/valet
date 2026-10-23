import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { externalCalls, orgs, teams, teamMembers, tagKeys } from "../schema/index.js";
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
    await tagger.tag("tool_intent", [{ type: "external_call", text: "Review code to find a bug.", ...rows[0]! }]);
    await db.insert(tagKeys).values({ orgId: "local-org", dimension: "tool_intent", key: "new_purpose", label: "New purpose",
      definition: "A distinct purpose.", status: "provisional", origin: "admin", createdAt: 1, updatedAt: 1 });
    await new Tagger({ db, orgId: "local-org", dimensions: [toolIntentDimension], renderers: new Map(),
      classify: async () => ({ text: '{"subjects":[{"index":0,"labels":[{"key":"new_purpose","confidence":1}]}]}', model: "fixed" }) })
      .tag("tool_intent", [{ type: "external_call", text: "A distinct purpose.", ...rows[1]! }]);
    const read = async (query: string, userId?: string) => {
      const res = await fetch(`${api!.baseUrl}/api/usage/external?window=7d${query}`, { headers: userId ? { "x-valet-test-user-id": userId } : {} });
      expect(res.status).toBe(200); return await res.json() as ExternalUsageResponse;
    };
    const mine = await read("");
    expect(mine.classification?.keys.find(key => key.key === "code_review")?.calls).toBe(1);
    expect(mine.classification?.keys.find(key => key.key === "new_purpose")?.calls).toBe(0);
    expect(mine.tools).toEqual([expect.objectContaining({ key: null, calls: 1 })]);
    const all = await read("&scope=org&surface=hosted&key=__emerging");
    expect(all.recent.map(row => row.id)).toEqual(["theirs"]);
    expect(all.tools).toEqual([expect.objectContaining({ key: null })]);
    const member = await read("&scope=team&teamId=team", "test-member");
    expect(member.recent).toEqual([]); expect(member.classification?.canManage).toBe(false);
    expect(member.classification?.keys.find(key => key.key === "new_purpose")).toBeUndefined();
    expect(member.classification?.emergingCalls).toBe(1);
    await tagger.registry.merge("tool_intent", "code_review", "debug_investigate");
    expect((await read("&key=debug_investigate")).recent[0]?.key).toBe("debug_investigate");
    expect((await read("&key=code_review")).recent).toEqual([]);
  });
  it("allows only org settings admins to edit or merge registry keys", async () => {
    api = await bootTestApi();
    await new Tagger({ db: api.providers.db, orgId: "local-org", dimensions: [toolIntentDimension], renderers: new Map(), classify: async () => ({ text: "{}", model: "fixed" }) }).initialize("tool_intent");
    const change = async (user: string, path: string, body: unknown, method = "PATCH") => fetch(`${api!.baseUrl}/api/org/tag-keys/tool_intent/${path}`, { method, headers: { "Content-Type": "application/json", "x-valet-test-user-id": user }, body: JSON.stringify(body) });
    expect((await change("test-member", "code_change", { label: "Changed", definition: "A definition." })).status).toBe(403);
    expect((await change("local-user", "code_change", { label: "Changes", definition: "Implementation work." })).status).toBe(200);
    expect((await change("local-user", "code_change/merge", { into: "code_review" }, "POST")).status).toBe(200);
    expect((await change("local-user", "other/merge", { into: "code_review" }, "POST")).status).toBe(409);
  });
});

it("groups one top-tool row across purpose keys and accounts for unlabeled calls", async () => {
  api = await bootTestApi(); const db = api.providers.db;
  await db.insert(externalCalls).values(["a", "b", "unlabeled"].map(id => ({ id, orgId: "local-org", userId: "local-user",
    surface: "mcp" as const, ownerType: "user" as const, ownerId: "local-user", name: "call_tool",
    intent: "Review or implement code.", outcome: "ok" as const, durationMs: 1, createdAt: Date.now() })));
  const tagger = new Tagger({ db, orgId: "local-org", dimensions: [toolIntentDimension], renderers: new Map(),
    classify: async () => ({ model: "fixed", text: '{"subjects":[{"index":0,"labels":[{"key":"code_review","confidence":1}]},{"index":1,"labels":[{"key":"code_change","confidence":1}]}]}' }) });
  await tagger.tag("tool_intent", ["a", "b"].map(id => ({ type: "external_call", id, text: "Code work.", userId: "local-user", ownerType: "user", ownerId: "local-user" })));
  const response = await fetch(`${api.baseUrl}/api/usage/external?window=7d`);
  expect(response.status).toBe(200); const usage = await response.json() as ExternalUsageResponse;
  expect(usage.tools).toEqual([expect.objectContaining({ name: "call_tool", surface: "mcp", calls: 3 })]);
  expect(usage.classification?.unlabeledCalls).toBe(1);
  expect((usage.classification?.keys.reduce((sum, key) => sum + key.calls, 0) ?? 0) + (usage.classification?.unlabeledCalls ?? 0))
    .toBe(usage.daily.reduce((sum, day) => sum + day.calls, 0));
});

it("excludes denied and pending calls from purpose error-rate denominators", async () => {
  api = await bootTestApi(); const db = api.providers.db;
  const outcomes = ["ok", "error", "denied", "pending-approval"] as const;
  await db.insert(externalCalls).values(outcomes.map(outcome => ({ id: outcome, orgId: "local-org", userId: "local-user", surface: "mcp" as const,
    ownerType: "user" as const, ownerId: "local-user", name: "call_tool", intent: "Review the code.", outcome, durationMs: 1, createdAt: Date.now() })));
  const tagger = new Tagger({ db, orgId: "local-org", dimensions: [toolIntentDimension], renderers: new Map(),
    classify: async req => ({ model: "fixed", text: JSON.stringify({ subjects: req.subjects.map((_subject, index) => ({ index,
      labels: [{ key: "code_review", confidence: 1 }] })) }) }) });
  await tagger.tag("tool_intent", outcomes.map(id => ({ type: "external_call", id, userId: "local-user", ownerType: "user", ownerId: "local-user", text: "Review the code." })));
  const usage = await (await fetch(`${api.baseUrl}/api/usage/external?window=7d`)).json() as ExternalUsageResponse;
  expect(usage.classification?.keys.find(key => key.key === "code_review")).toMatchObject({ calls: 4, errorRate: .5 });
});
