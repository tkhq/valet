import { and, eq } from "drizzle-orm";
import type { PolicyDecision } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { authorizationDecisions, authorizationExecutionAttempts } from "../schema/index.js";

export const INDETERMINATE_EXECUTION = "indeterminate_execution: the action may have run. Do not retry automatically.";
type Attempt = typeof authorizationExecutionAttempts.$inferSelect;
export type DurableReplay<T> = { kind: "execute"; attemptId: string } | { kind: "completed"; result: T } | { kind: "failed"; error: string; result?: T } | { kind: "indeterminate"; error: string };
export type DurableSettlement<T> = { outcome: "completed"; result: T } | { outcome: "failed"; error: string; result?: T };

export type StartedRecovery<T> = { kind: "completed"; result: T } | { kind: "absent" } | { kind: "ambiguous"; error: string };

export async function reserveCanonicalExecution<T>(db: AppDb, decision: PolicyDecision, executionInputDigest: string, parse: (value: unknown) => T, now: () => number, recover?: (tx: AppDb) => Promise<StartedRecovery<T>>): Promise<DurableReplay<T>> {
  const identity = await canonicalExecutionIdentity(db, decision, executionInputDigest);
  const attemptId = `attempt:${identity.decisionId.slice("decision:".length)}`;
  const inserted = await db.insert(authorizationExecutionAttempts).values({ attemptId, decisionId: identity.decisionId, outcome: "started", targetIdempotencyKey: identity.idempotencyKey, externalOperationIds: [], startedAt: now(), createdAt: now() }).onConflictDoNothing().returning({ attemptId: authorizationExecutionAttempts.attemptId });
  if (inserted[0]) return { kind: "execute", attemptId };
  if (!recover) return replay(await loadAttempt(db, attemptId), identity, parse);
  return db.transaction(async (tx) => {
    const locked = await tx.update(authorizationExecutionAttempts).set({ startedAt: now() }).where(and(eq(authorizationExecutionAttempts.attemptId, attemptId), eq(authorizationExecutionAttempts.outcome, "started"))).returning({ attemptId: authorizationExecutionAttempts.attemptId });
    if (!locked[0]) return replay(await loadAttempt(tx, attemptId), identity, parse);
    const recovered = await recover(tx);
    if (recovered.kind === "completed") {
      await tx.update(authorizationExecutionAttempts).set({ outcome: "completed", redactedResult: recovered.result, finishedAt: now() }).where(eq(authorizationExecutionAttempts.attemptId, attemptId));
      return recovered;
    }
    if (recovered.kind === "ambiguous") return { kind: "indeterminate", error: recovered.error };
    await tx.update(authorizationExecutionAttempts).set({ redactedResult: null, redactedError: null, finishedAt: null, startedAt: now() }).where(eq(authorizationExecutionAttempts.attemptId, attemptId));
    return { kind: "execute", attemptId };
  });
}

export async function completeCanonicalExecution<T>(db: AppDb, decision: PolicyDecision, executionInputDigest: string, attemptId: string, settlement: DurableSettlement<T>, normalize: (value: DurableSettlement<T>) => DurableSettlement<T>, parse: (value: unknown) => T, now: () => number): Promise<DurableSettlement<T>> {
  const identity = await canonicalExecutionIdentity(db, decision, executionInputDigest);
  assertAttempt(await loadAttempt(db, attemptId), identity);
  const persisted = normalize(settlement);
  const values = persisted.outcome === "completed" ? { outcome: "completed" as const, redactedResult: persisted.result, redactedError: null, finishedAt: now() } : { outcome: "failed" as const, redactedResult: persisted.result ?? null, redactedError: persisted.error, finishedAt: now() };
  const updated = await db.update(authorizationExecutionAttempts).set(values).where(and(eq(authorizationExecutionAttempts.attemptId, attemptId), eq(authorizationExecutionAttempts.outcome, "started"))).returning({ attemptId: authorizationExecutionAttempts.attemptId });
  if (updated[0]) return persisted;
  const prior = replay(await loadAttempt(db, attemptId), identity, parse);
  if (prior.kind === "completed") return { outcome: "completed", result: prior.result };
  if (prior.kind === "failed") return { outcome: "failed", error: prior.error, ...(prior.result === undefined ? {} : { result: prior.result }) };
  return { outcome: "failed", error: INDETERMINATE_EXECUTION };
}

async function canonicalExecutionIdentity(db: AppDb, decision: PolicyDecision, digest: string) {
  const canonical = decision.canonical;
  if (!canonical?.decisionId || canonical.executionInputDigest !== digest) throw new Error("Canonical interactive execution decision identity is invalid.");
  const row = (await db.select().from(authorizationDecisions).where(eq(authorizationDecisions.decisionId, canonical.decisionId)).limit(1))[0];
  if (!row || row.effect !== "allow" || row.requestSubjectDigest !== canonical.requestSubjectDigest || row.inputDigest !== canonical.inputDigest || row.evidence?.decisionDigest !== canonical.decisionDigest) throw new Error("Canonical interactive execution decision identity is invalid.");
  return { decisionId: row.decisionId, idempotencyKey: row.idempotencyKey };
}
async function loadAttempt(db: AppDb, id: string): Promise<Attempt | undefined> { return (await db.select().from(authorizationExecutionAttempts).where(eq(authorizationExecutionAttempts.attemptId, id)).limit(1))[0]; }
function assertAttempt(row: Attempt | undefined, identity: { decisionId: string; idempotencyKey: string }): asserts row is Attempt { if (!row || row.decisionId !== identity.decisionId || row.targetIdempotencyKey !== identity.idempotencyKey) throw new Error("Canonical interactive execution attempt identity is invalid."); }
function replay<T>(row: Attempt | undefined, identity: { decisionId: string; idempotencyKey: string }, parse: (value: unknown) => T): DurableReplay<T> { assertAttempt(row, identity); if (row.outcome === "completed") return { kind: "completed", result: parse(row.redactedResult) }; if (row.outcome === "failed" && row.redactedError) return { kind: "failed", error: row.redactedError, ...(row.redactedResult === null ? {} : { result: parse(row.redactedResult) }) }; return { kind: "indeterminate", error: INDETERMINATE_EXECUTION }; }
