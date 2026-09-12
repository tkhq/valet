import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { pgDbFromPglite } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import {
  authorizationDecisions,
  authorizationExecutionAttempts,
  type AuthorizationDecisionRow,
  type AuthorizationExecutionAttemptRow,
} from "../schema/index.js";

type IsAssignable<Value, Target> = Value extends Target ? true : false;

describe("authorization audit schema", () => {
  const pglite = new PGlite();
  const query = pgDbFromPglite(pglite);
  const db = buildAppDb(pglite);

  beforeAll(async () => {
    await applyAppMigrations(query);
  });

  afterAll(async () => {
    await query.close();
  });

  it("stores policy decisions and execution attempts separately", async () => {
    await db.insert(authorizationDecisions).values({
      decisionId: "decision-1",
      orgId: "org-1",
      requestId: "request-1",
      idempotencyKey: "interactive:invocation-1",
      requestSubjectDigest: "subject-digest",
      inputDigest: "input-digest",
      policyDigest: "policy-digest",
      compiledBundleDigest: "bundle-digest",
      evaluatorKind: "local_valet",
      evaluatorEngineDigest: "engine-digest",
      effect: "allow",
      reasonCode: "policy.allow",
      matchedRuleIds: ["rule-1"],
      obligations: [{ type: "target_idempotency", required: true }],
      redactions: [],
      proofVerificationStatus: "not_required",
      identityFactProvenance: [{ source: "host_asserted" }],
      policyFactProvenance: [{ source: "host_asserted" }],
      evaluatedAt: 100,
      createdAt: 100,
    });
    await db.insert(authorizationExecutionAttempts).values({
      attemptId: "attempt-1",
      decisionId: "decision-1",
      outcome: "completed",
      targetIdempotencyKey: "target-1",
      externalOperationIds: ["external-1"],
      startedAt: 101,
      finishedAt: 102,
      createdAt: 101,
    });

    expect(await db.select({ effect: authorizationDecisions.effect }).from(authorizationDecisions)).toEqual([
      { effect: "allow" },
    ]);
    expect(
      await db.select({ outcome: authorizationExecutionAttempts.outcome }).from(authorizationExecutionAttempts),
    ).toEqual([{ outcome: "completed" }]);
  });

  it("rejects decision effects as execution outcomes", async () => {
    await expect(
      query.query(
        `INSERT INTO authorization_execution_attempts
          (attempt_id, decision_id, outcome, external_operation_ids, started_at, created_at)
         VALUES ('attempt-invalid', 'decision-1', 'allow', '[]', 103, 103)`,
      ),
    ).rejects.toThrow();
  });

  it("rejects execution outcomes as decision effects", async () => {
    await expect(
      query.query(
        `INSERT INTO authorization_decisions
          (decision_id, org_id, request_id, idempotency_key, request_subject_digest,
           input_digest, policy_digest, compiled_bundle_digest, evaluator_kind,
           evaluator_engine_digest, effect, reason_code, matched_rule_ids,
           obligations, redactions, proof_verification_status,
           identity_fact_provenance, policy_fact_provenance, evaluated_at, created_at)
         VALUES ('decision-invalid', 'org-1', 'request-2', 'route:operation-2',
           'subject-2', 'input-2', 'policy-2', 'bundle-2', 'local_valet',
           'engine-2', 'completed', 'invalid', '[]', '[]', '[]', 'not_required',
           '[]', '[]', 104, 104)`,
      ),
    ).rejects.toThrow();
  });

  it("keeps decision and execution row types distinct", () => {
    expectTypeOf<IsAssignable<AuthorizationDecisionRow, AuthorizationExecutionAttemptRow>>().toEqualTypeOf<false>();
    expectTypeOf<IsAssignable<AuthorizationExecutionAttemptRow, AuthorizationDecisionRow>>().toEqualTypeOf<false>();
  });
});
