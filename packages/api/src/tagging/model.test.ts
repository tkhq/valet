import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { sql } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { ensureEnvProviders } from "../proxy/upstream.js";
import { getUsageBreakdown } from "../services/usage.js";
import { taggingModel } from "./model.js";

afterEach(() => vi.unstubAllEnvs());
it("uses the configured XS provider and projects billed tokens with user and team attribution", async () => {
  const fixture = await freshTestPgDb();
  const db = fixture.appDb;
  const credentials = new PgCredentialStore(fixture.pgdb, deriveSecretKey("test-key"));
  await db.insert(orgs).values({ id: "org", name: "Tagging", createdAt: 1 });
  vi.stubEnv("ANTHROPIC_API_KEY", "test-fixture-key");
  await ensureEnvProviders(db, credentials, "org");
  const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  try {
    faux.setResponses([fauxAssistantMessage('{"subjects":[]}')]);
    const classify = taggingModel(db, credentials, "org");
    const result = await classify({ dimension: "tool_intent", prompt: "Classify purpose data.", signal: AbortSignal.timeout(30000), subjects: [
      { type: "external_call", id: "one", text: "Look up facts.", userId: "alice", ownerType: "user", ownerId: "alice" },
      { type: "external_call", id: "two", text: "Review code.", userId: "bob", ownerType: "team", ownerId: "team" },
      { type: "external_call", id: "automated", text: "Run the scheduled report.", userId: null, ownerType: "team", ownerId: "team" },
    ] });
    expect(result.model).toContain("haiku");
    const rows = await db.execute(sql`SELECT user_id, owner_type, owner_id, total_tokens FROM cost_entries WHERE session_id LIKE 'tagger:%'`) as { rows: { user_id: string; owner_type: string; owner_id: string; total_tokens: unknown }[] };
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows).toEqual(expect.arrayContaining([expect.objectContaining({ user_id: "alice", owner_type: "user", owner_id: "alice" }), expect.objectContaining({ user_id: "bob", owner_type: "team", owner_id: "team" }), expect.objectContaining({ user_id: "team:team", owner_type: "team", owner_id: "team" })]));
    expect(rows.rows.reduce((sum, row) => sum + Number(row.total_tokens), 0)).toBeGreaterThan(0);
    const breakdown = await getUsageBreakdown(db, { scope: { scope: "me", orgId: "org", userId: "alice" }, windowMs: 86400000 });
    expect(breakdown.totalTokens).toBeGreaterThan(0);
    expect(breakdown.activeAgents).toBe(0);
  } finally { faux.unregister(); }
});
