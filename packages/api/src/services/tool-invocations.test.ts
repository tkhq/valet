import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { actionInvocations } from "../schema/index.js";
import { InvocationBindingMismatchError, McpInvocationStore, invocationEnvelope } from "./tool-invocations.js";

const pglite = new PGlite();
const pg = pgDbFromPglite(pglite);
const db = buildAppDb(pglite);
const binding = {
  userId: "user_1",
  orgId: "org_1",
  clientInvocationId: "client_1",
  orchestratorId: "asst_1",
  sessionId: "assistant:asst_1",
  threadId: "thread_1",
  actionId: "fixture.increment",
  args: { amount: 1 },
  sourceIp: "127.0.0.1",
};

beforeAll(async () => applyAppMigrations(pg));
beforeEach(async () => { await pg.query("DELETE FROM action_invocations"); });
afterAll(async () => pglite.close());

describe("MCP invocation state", () => {
  it("binds raw arguments and leaves the canonical row unchanged on mismatched reuse", async () => {
    const store = new McpInvocationStore(db, () => 10);
    const row = await store.open(binding);
    await expect(store.open({ ...binding, args: { amount: 2 } })).rejects.toBeInstanceOf(InvocationBindingMismatchError);
    const stored = await store.get(row.invocationId);
    expect(stored?.params).toEqual({ amount: 1 });
    expect(stored?.status).toBe("created");
  });

  it("allows exactly one parallel execution claim", async () => {
    const store = new McpInvocationStore(db, () => 20);
    const row = await store.open(binding);
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimExecution(row.invocationId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await store.get(row.invocationId))?.status).toBe("executing");
  });

  it("never auto-transitions or reclaims an executing invocation", async () => {
    const store = new McpInvocationStore(db, () => 30);
    const row = await store.open(binding);
    expect(await store.claimExecution(row.invocationId)).toBe(true);
    expect(await store.claimExecution(row.invocationId)).toBe(false);
    const executing = await store.get(row.invocationId);
    expect(executing?.status).toBe("executing");
    expect(invocationEnvelope(executing!).status).toBe("in_progress_or_interrupted");
  });

  it("replays completed and indeterminate terminal outcomes", async () => {
    const store = new McpInvocationStore(db, () => 40);
    const complete = await store.open(binding);
    await store.claimExecution(complete.invocationId);
    const completed = await store.markTerminal(complete.invocationId, "executing", { state: "completed", result: { success: true, data: 1 } });
    expect(invocationEnvelope(completed)).toEqual(invocationEnvelope((await store.get(complete.invocationId))!));

    await pg.query("DELETE FROM action_invocations");
    const uncertain = await store.open(binding);
    await store.claimExecution(uncertain.invocationId);
    const indeterminate = await store.markTerminal(uncertain.invocationId, "executing", { state: "indeterminate", error: "provider threw" });
    expect(invocationEnvelope(indeterminate).status).toBe("indeterminate");
    expect(await store.claimExecution(uncertain.invocationId)).toBe(false);
  });

  it("leaves executing durable when terminal result persistence fails", async () => {
    const store = new McpInvocationStore(db, () => 45);
    const row = await store.open(binding);
    expect(await store.claimExecution(row.invocationId)).toBe(true);
    await pg.query(`CREATE FUNCTION reject_mcp_terminal() RETURNS trigger AS 'BEGIN IF NEW.status IN (''completed'', ''indeterminate'') THEN RAISE EXCEPTION ''injected terminal outage''; END IF; RETURN NEW; END;' LANGUAGE plpgsql`);
    await pg.query(`CREATE TRIGGER reject_mcp_terminal BEFORE UPDATE ON action_invocations FOR EACH ROW EXECUTE FUNCTION reject_mcp_terminal()`);
    try {
      await expect(store.markTerminal(row.invocationId, "executing", { state: "completed", result: { success: true } })).rejects.toThrow();
      expect((await store.get(row.invocationId))?.status).toBe("executing");
      expect(await store.claimExecution(row.invocationId)).toBe(false);
    } finally {
      await pg.query(`DROP TRIGGER reject_mcp_terminal ON action_invocations`);
      await pg.query(`DROP FUNCTION reject_mcp_terminal()`);
    }
  });

  it("bounds persisted parameters and replay results", async () => {
    const store = new McpInvocationStore(db, () => 48);
    const row = await store.open({ ...binding, args: { payload: "x".repeat(20_000) } });
    expect(row.paramsTruncated).toBe(true);
    expect(await store.claimExecution(row.invocationId)).toBe(true);
    const completed = await store.markTerminal(row.invocationId, "executing", { state: "completed", result: { payload: "y".repeat(20_000) } });
    expect(completed.resultTruncated).toBe(true);
    expect(JSON.stringify(invocationEnvelope(completed)).length).toBeLessThan(9_000);
  });

  it("keeps one canonical row through approval and execution", async () => {
    const store = new McpInvocationStore(db, () => 50);
    const row = await store.open(binding);
    await store.markPending(row.invocationId);
    expect(await store.claimExecution(row.invocationId)).toBe(true);
    await store.markTerminal(row.invocationId, "executing", { state: "completed", result: { success: true } });
    expect(await db.select().from(actionInvocations)).toHaveLength(1);
  });
});
