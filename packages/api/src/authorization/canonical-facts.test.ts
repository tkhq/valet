import { afterEach, describe, expect, it } from "vitest";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { canonicalApprovalResolutions, runtimeGrants } from "../schema/index.js";
import { loadCanonicalDynamicFacts } from "./canonical-facts.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

const query = {
  organizationId: "org-1", service: "gmail", actionId: "gmail.send", riskLevel: "high" as const,
  appliesIn: "session" as const, scopeId: "session-1", evaluationTimeMs: 100,
  requestSubjectDigest: "a".repeat(64), originalDecisionDigest: "b".repeat(64),
};

describe("canonical dynamic facts", () => {
  it("loads exact bounded grant and approval facts", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(runtimeGrants).values({ id: "grant-1", orgId: "org-1", sessionId: "session-1", policyKey: "gmail.send", service: "gmail", actionId: "gmail.send", riskLevel: "high", sourceApprovalId: "approval-1", expiresAt: 200, grantedBy: "user-1", createdAt: 50 });
    await pg.appDb.insert(canonicalApprovalResolutions).values({ resolutionId: "resolution-1", approvalId: "approval-1", gateId: "gate-1", orgId: "org-1", requestSubjectDigest: query.requestSubjectDigest, originalDecisionDigest: query.originalDecisionDigest, approverId: "user-1", verdict: "approved", appliesIn: "session", sessionId: "session-1", resolvedAt: 60, expiresAt: 200, resolutionVersion: 1 });
    await expect(loadCanonicalDynamicFacts(pg.appDb, query)).resolves.toMatchObject({
      schemaVersion: 2, organizationId: "org-1", grants: [["grant-1", "gmail.send", "gmail", "gmail.send", "high", "session", "session-1", 50, 200, null]],
      approvalBinding: [query.requestSubjectDigest, query.originalDecisionDigest, "session", "session-1"], approvals: [["resolution-1", "approved", 60, 200, 1]],
    });
  });

  it("fails closed for an incomplete legacy grant", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(runtimeGrants).values({ id: "grant-1", orgId: "org-1", sessionId: "session-1", policyKey: "gmail.send", grantedBy: "user-1", createdAt: 50, expiresAt: 200 });
    await expect(loadCanonicalDynamicFacts(pg.appDb, query)).rejects.toThrow(/incomplete/);
  });

  it("accepts only an active grant for the exact workflow action and risk", async () => {
    const workflowQuery = { ...query, appliesIn: "workflow" as const, scopeId: "run-1" };
    const base = {
      orgId: "org-1",
      workflowExecutionId: "run-1",
      policyKey: "gmail.send",
      service: "gmail",
      actionId: "gmail.send",
      riskLevel: "high" as const,
      sourceApprovalId: "approval-1",
      expiresAt: 200,
      grantedBy: "user-1",
      createdAt: 50,
    };

    for (const [name, mutation, outcome] of [
      ["exact", {}, "accepted"],
      ["service", { service: "github" }, "rejected"],
      ["action", { actionId: "gmail.delete" }, "rejected"],
      ["risk", { riskLevel: "critical" }, "rejected"],
      ["run", { workflowExecutionId: "run-2" }, "ignored"],
      ["org", { orgId: "org-2" }, "ignored"],
      ["expired", { expiresAt: 100 }, "ignored"],
      ["revoked", { revokedAt: 90 }, "ignored"],
    ] as const) {
      pg = await freshTestPgDb();
      await pg.appDb.insert(runtimeGrants).values({ id: `grant-${name}`, ...base, ...mutation });
      const loaded = loadCanonicalDynamicFacts(pg.appDb, workflowQuery);
      if (outcome === "rejected") await expect(loaded).rejects.toThrow(/malformed/);
      else await expect(loaded).resolves.toMatchObject({ grants: outcome === "accepted" ? [expect.any(Array)] : [] });
      await pg.cleanup();
      pg = undefined;
    }
  });
});
