import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, eq, gt } from "drizzle-orm";
import type { AuthorizationRequest, JsonValue } from "@valet/engine/authorization";
import { CanonicalPolicyConfigManagedError, CanonicalPolicySourceReadOnlyError, type CanonicalPolicyBundleManager } from "../canonical-policy-manager.js";
import type { AppDb, AppQueryable } from "../../lib/drizzle.js";
import { policyAuthoringAudit, policyAuthoringDocuments, policyAuthoringOperations, policyAuthoringReviews, policyAuthoringRevisions } from "../../schema/index.js";
import { buildCurrentPolicySource } from "../bundles/current-policy-source.js";
import { SourceBundleHost } from "../bundles/host.js";
import { InMemorySourceBundleStorage } from "../bundles/in-memory-storage.js";
import type { CanonicalSourceBundle, ValidatedBundleIdentity } from "../bundles/types.js";
import { LocalValetEvaluator } from "../evaluators/local-valet.js";
import { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import { projectActionDraftToCurrentSnapshot } from "./current-action-projection.js";
import { normalizePolicyDraft, sanitizeSampleFacts, validatePolicyDraft } from "./model.js";
import type {
  CreatePolicyDraftRequest,
  DraftValidationIssue,
  EditPolicyDraftRequest,
  NormalizedPolicyDraftV1,
  PolicyAuthoringDocument,
  PolicyAuthoringOperation,
  PolicyAuthoringScope,
  PolicyMutationBase,
  PolicyPreviewServerRequest,
  PolicyRevisionDiffV1,
  PolicyValidationSummary,
  ReviewPolicyDraftRequest,
} from "./types.js";

export class PolicyAuthoringError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "forbidden" | "not_found" | "unsupported" | "self_review" | "internal",
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 | 422 | 500,
  ) {
    super(message);
    this.name = "PolicyAuthoringError";
  }
}
export interface PolicyAuthoringAuthorizer {
  authorize(operation: PolicyAuthoringOperation, actorId: string, scope: PolicyAuthoringScope, db: AppQueryable): Promise<boolean | "not_found">;
}
export interface PolicyAuthoringCompiler {
  compile(
    draft: NormalizedPolicyDraftV1,
    scope: PolicyAuthoringScope,
  ): Promise<{ bundle?: CanonicalSourceBundle; identity?: ValidatedBundleIdentity; validation: PolicyValidationSummary; source?: { rego: string; data: string } }>;
  evaluate(bundle: CanonicalSourceBundle, identity: ValidatedBundleIdentity, request: AuthorizationRequest): Promise<object>;
}
let runtime: WasmPolicyRuntime | undefined;
export const policyAuthoringCompiler: PolicyAuthoringCompiler = {
  async compile(draft, scope) {
    if (draft.rules.some((rule) => rule.context !== "tool.action"))
      return {
        validation: {
          valid: true,
          publishable: false,
          issues: [issue("unsupported_authorization_context", "rules", "This context can be saved, but it cannot be reviewed or prepared for publication yet.")],
        },
      };
    try {
      const built = buildCurrentPolicySource(projectActionDraftToCurrentSnapshot(draft, scope.organizationId));
      runtime ??= new WasmPolicyRuntime();
      const identity = await runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: built.bundle });
      return { bundle: built.bundle, identity, validation: { valid: true, publishable: true, issues: [] }, source: { rego: built.policySource, data: built.canonicalData } };
    } catch {
      return {
        validation: { valid: false, publishable: false, issues: [issue("source_validation", "rules", "The policy engine rejected this draft. Correct the draft and retry.")] },
      };
    }
  },
  async evaluate(bundle, identity, request) {
    runtime ??= new WasmPolicyRuntime();
    const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime),
      validated = await host.publish(bundle);
    if (!sameIdentity(validated, identity)) throw new Error("identity mismatch");
    await host.activate(request.subject.orgId, undefined, identity.sourceBundleDigest);
    return (await LocalValetEvaluator.create(host, runtime)).evaluate(request);
  },
};
interface ServiceDeps {
  db: AppDb;
  authorizer: PolicyAuthoringAuthorizer;
  compiler?: PolicyAuthoringCompiler;
  now?: () => number;
  auditWrite?: typeof writeAudit;
  canonicalPolicyManager?: CanonicalPolicyBundleManager;
}
type DocumentRow = typeof policyAuthoringDocuments.$inferSelect;
type RevisionRow = typeof policyAuthoringRevisions.$inferSelect;
type MutationOperation = Exclude<PolicyAuthoringOperation, "view" | "prepare_publication">;
const MAX_DOCUMENTS = 1000,
  MAX_REVISIONS = 100,
  DEFAULT_LIMIT = 50,
  MAX_LIMIT = 100;

export class PolicyAuthoringService {
  private readonly compiler: PolicyAuthoringCompiler;
  private readonly now: () => number;
  private readonly auditWrite: typeof writeAudit;
  constructor(private readonly deps: ServiceDeps) {
    this.compiler = deps.compiler ?? policyAuthoringCompiler;
    this.now = deps.now ?? Date.now;
    this.auditWrite = deps.auditWrite ?? writeAudit;
  }
  async list(actor: string, scope: PolicyAuthoringScope, cursor?: string, requestedLimit = DEFAULT_LIMIT) {
    return this.safe(async () => {
      await this.allowed("view", actor, scope, this.deps.db);
      if (cursor && (cursor.length > 128 || !/^[A-Za-z0-9-]+$/.test(cursor))) invalid("Use the next cursor returned by the policy draft list.");
      const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT,
        where = and(
          eq(policyAuthoringDocuments.orgId, scope.organizationId),
          eq(policyAuthoringDocuments.scopeKey, scopeKey(scope)),
          cursor ? gt(policyAuthoringDocuments.id, cursor) : undefined,
        );
      const rows = await this.deps.db
        .select()
        .from(policyAuthoringDocuments)
        .where(where)
        .orderBy(asc(policyAuthoringDocuments.id))
        .limit(limit + 1);
      return { documents: rows.slice(0, limit).map(toDocument), nextCursor: rows.length > limit ? rows[limit - 1].id : undefined };
    });
  }
  async get(actor: string, scope: PolicyAuthoringScope, id: string) {
    return this.safe(async () => {
      const row = await this.scoped(this.deps.db, scope, id);
      await this.allowed("view", actor, scope, this.deps.db);
      return { document: toDocument(row), draft: (await this.revision(this.deps.db, row, row.revision)).draft };
    });
  }
  async create(actor: string, scope: PolicyAuthoringScope, input: CreatePolicyDraftRequest): Promise<PolicyAuthoringDocument> {
    return this.safe(async () => {
      base(input, true);
      await this.allowed("edit", actor, scope, this.deps.db);
      const op = operationIdentity(scope, actor, "create", "create", input),
        replay = await findReplay(this.deps.db, op);
      if (replay) return replay;
      this.assertScope(input.draft, scope);
      const compiled = await this.normalized(input.draft, scope);
      return this.deps.db.transaction(async (tx) => {
        await this.allowed("edit", actor, scope, tx);
        const again = await claim(tx, op, this.now());
        if (again) return again;
        const [{ value }] = await tx
          .select({ value: count() })
          .from(policyAuthoringDocuments)
          .where(and(eq(policyAuthoringDocuments.orgId, scope.organizationId), eq(policyAuthoringDocuments.scopeKey, scopeKey(scope))));
        if (value >= MAX_DOCUMENTS) throw conflict(`This scope has ${MAX_DOCUMENTS} policy drafts. Remove an unused draft before you create another.`);
        const now = this.now(),
          values = documentValues(randomUUID(), scope, actor, compiled, now);
        await tx.insert(policyAuthoringDocuments).values(values);
        await insertRevision(tx, values, compiled.draft, compiled.result.bundle, actor, now);
        return this.finish(tx, toDocument(values), actor, "create", input.idempotencyKey, null, op);
      });
    });
  }
  async edit(actor: string, scope: PolicyAuthoringScope, id: string, input: EditPolicyDraftRequest): Promise<PolicyAuthoringDocument> {
    return this.safe(async () => {
      base(input, false, ["draft"]);
      await this.preflight("edit", actor, scope, id);
      const op = operationIdentity(scope, actor, "edit", id, input),
        replay = await findReplay(this.deps.db, op);
      if (replay) return replay;
      this.assertScope(input.draft, scope);
      const compiled = await this.normalized(input.draft, scope);
      return this.deps.db.transaction(async (tx) => {
        const old = await this.scoped(tx, scope, id);
        await this.allowed("edit", actor, scope, tx);
        const again = await claim(tx, op, this.now());
        if (again) return again;
        cas(old, input);
        if (old.revision >= MAX_REVISIONS) throw conflict(`This policy draft has ${MAX_REVISIONS} revisions. Create a new policy draft before you edit it again.`);
        const now = this.now(),
          updated = await tx
            .update(policyAuthoringDocuments)
            .set({
              status: "draft",
              revision: old.revision + 1,
              stateVersion: old.stateVersion + 1,
              reviewCycle: null,
              normalizedIdentity: compiled.draft.normalizedIdentity,
              sourceBundleDigest: compiled.result.identity?.sourceBundleDigest ?? null,
              policyDigest: compiled.result.identity?.policyDigest ?? null,
              engineDigest: compiled.result.identity?.engineDigest ?? null,
              validationSummary: compiled.result.validation,
              updatedAt: now,
            })
            .where(casWhere(old, input))
            .returning();
        if (!updated[0]) throw conflict();
        await insertRevision(tx, updated[0], compiled.draft, compiled.result.bundle, actor, now);
        return this.finish(tx, toDocument(updated[0]), actor, "edit", input.idempotencyKey, old.status, op);
      });
    });
  }
  async submit(actor: string, scope: PolicyAuthoringScope, id: string, input: PolicyMutationBase) {
    return this.transition(actor, scope, id, input);
  }
  async review(actor: string, scope: PolicyAuthoringScope, id: string, input: ReviewPolicyDraftRequest): Promise<PolicyAuthoringDocument> {
    return this.safe(async () => {
      base(input, false, ["verdict", "requestId"]);
      if (!input.requestId || !["approve", "reject"].includes(input.verdict)) invalid("Send one review verdict and request ID.");
      await this.preflight("review", actor, scope, id);
      const op = operationIdentity(scope, actor, "review", id, input),
        replay = await findReplay(this.deps.db, op);
      if (replay) return replay;
      return this.deps.db.transaction(async (tx) => {
        const old = await this.scoped(tx, scope, id);
        await this.allowed("review", actor, scope, tx);
        const again = await claim(tx, op, this.now());
        if (again) return again;
        cas(old, input);
        if (old.status !== "in_review" || old.reviewCycle !== input.expectedStateVersion) throw conflict("Review the current submission cycle with its exact state version.");
        const revision = await this.revision(tx, old, old.revision);
        if (revision.createdBy === actor) throw new PolicyAuthoringError("self_review", "Ask a different administrator to review this policy draft.", 403);
        if (!completeIdentity(revision)) throw unsupported();
        const status = input.verdict === "approve" ? ("approved_for_publication" as const) : ("draft" as const),
          now = this.now(),
          updated = await tx
            .update(policyAuthoringDocuments)
            .set({ status, stateVersion: old.stateVersion + 1, updatedAt: now })
            .where(casWhere(old, input))
            .returning();
        if (!updated[0]) throw conflict();
        await tx.insert(policyAuthoringReviews).values({
          id: randomUUID(),
          orgId: old.orgId,
          scopeKey: old.scopeKey,
          documentId: id,
          revision: old.revision,
          reviewCycle: old.reviewCycle,
          normalizedIdentity: old.normalizedIdentity,
          sourceBundleDigest: revision.sourceBundleDigest,
          policyDigest: revision.policyDigest,
          engineDigest: revision.engineDigest,
          reviewerId: actor,
          verdict: input.verdict,
          requestId: input.requestId,
          createdAt: now,
        });
        return this.finish(tx, toDocument(updated[0]), actor, "review", input.idempotencyKey, old.status, op);
      });
    });
  }
  async restore(actor: string, scope: PolicyAuthoringScope, id: string, from: number, input: PolicyMutationBase): Promise<PolicyAuthoringDocument> {
    return this.safe(async () => {
      base(input);
      await this.preflight("restore_draft", actor, scope, id);
      const op = operationIdentity(scope, actor, "restore_draft", id, { from, input }),
        replay = await findReplay(this.deps.db, op);
      if (replay) return replay;
      return this.deps.db.transaction(async (tx) => {
        const old = await this.scoped(tx, scope, id);
        await this.allowed("restore_draft", actor, scope, tx);
        const again = await claim(tx, op, this.now());
        if (again) return again;
        cas(old, input);
        if (old.revision >= MAX_REVISIONS) throw conflict(`This policy draft has ${MAX_REVISIONS} revisions. Create a new policy draft before you restore it.`);
        const source = await this.revision(tx, old, from),
          now = this.now(),
          updated = await tx
            .update(policyAuthoringDocuments)
            .set({
              status: "draft",
              revision: old.revision + 1,
              stateVersion: old.stateVersion + 1,
              reviewCycle: null,
              normalizedIdentity: source.normalizedIdentity,
              sourceBundleDigest: source.sourceBundleDigest,
              policyDigest: source.policyDigest,
              engineDigest: source.engineDigest,
              validationSummary: source.validationSummary,
              updatedAt: now,
            })
            .where(casWhere(old, input))
            .returning();
        if (!updated[0]) throw conflict();
        await insertRevision(tx, updated[0], source.draft, source.bundle ?? undefined, actor, now);
        return this.finish(tx, toDocument(updated[0]), actor, "restore_draft", input.idempotencyKey, old.status, op);
      });
    });
  }
  async prepare(actor: string, scope: PolicyAuthoringScope, id: string, expected: Pick<PolicyMutationBase, "expectedRevision" | "expectedStateVersion">) {
    return this.safe(async () => {
      let row = await this.scoped(this.deps.db, scope, id);
      await this.allowed("prepare_publication", actor, scope, this.deps.db);
      cas(row, expected);
      if (row.status !== "approved_for_publication" || !row.reviewCycle) throw conflict("Approve this exact submission cycle before preparation.");
      const revision = await this.revision(this.deps.db, row, row.revision),
        rebuilt = (await this.normalized(revision.draft, scope)).result;
      row = await this.scoped(this.deps.db, scope, id);
      await this.allowed("prepare_publication", actor, scope, this.deps.db);
      cas(row, expected);
      const review = (
        await this.deps.db
          .select()
          .from(policyAuthoringReviews)
          .where(
            and(
              eq(policyAuthoringReviews.orgId, row.orgId),
              eq(policyAuthoringReviews.scopeKey, row.scopeKey),
              eq(policyAuthoringReviews.documentId, id),
              eq(policyAuthoringReviews.revision, row.revision),
              eq(policyAuthoringReviews.reviewCycle, row.reviewCycle!),
              eq(policyAuthoringReviews.verdict, "approve"),
            ),
          )
          .limit(1)
      )[0];
      if (
        !review ||
        !rebuilt.validation.publishable ||
        !rebuilt.bundle ||
        !rebuilt.identity ||
        !sameStoredIdentity(rebuilt.identity, row) ||
        !sameStoredIdentity(rebuilt.identity, review)
      )
        throw conflict("The approved candidate identity changed. Submit it for a new review before preparation.");
      if (!this.deps.canonicalPolicyManager) throw new Error("Canonical policy manager is unavailable.");
      await this.deps.canonicalPolicyManager.activateCandidate(scope.organizationId, rebuilt.identity, rebuilt.bundle, { actorId: actor, operation: "policy_authoring_publish", idempotencyKey: `${id}:${row.revision}:${row.stateVersion}` });
      return { document: toDocument(row), draft: revision.draft, bundle: rebuilt.bundle, notice: "This candidate is the active canonical policy bundle." };
    });
  }
  async preview(actor: string, scope: PolicyAuthoringScope, input: PolicyPreviewServerRequest) {
    return this.safe(async () => {
      await this.allowed("view", actor, scope, this.deps.db);
      if (input.schemaVersion !== 1 || Object.keys(input).some((key) => !["schemaVersion", "draft", "sampleFacts", "clientNormalizedIdentity"].includes(key)))
        invalid("Send a version 1 preview request without unknown fields.");
      this.assertScope(input.draft, scope);
      const compiled = await this.normalized(input.draft, scope);
      if (input.clientNormalizedIdentity && input.clientNormalizedIdentity !== compiled.draft.normalizedIdentity) invalid("Normalize the current draft again before preview.");
      if (!compiled.result.bundle || !compiled.result.identity || !compiled.result.source) throw unsupported();
      const facts = sanitizeSampleFacts(compiled.draft.rules[0]?.context ?? "tool.action", input.sampleFacts),
        request = previewRequest(compiled.draft, scope, actor, facts, this.now());
      let evaluation: object;
      try {
        evaluation = await this.compiler.evaluate(compiled.result.bundle, compiled.result.identity, request);
        validateEvaluation(evaluation, compiled.result.identity);
      } catch {
        throw engineFailure();
      }
      const result = {
        schemaVersion: 1,
        identity: compiled.draft.normalizedIdentity,
        sourceBundleDigest: compiled.result.identity.sourceBundleDigest,
        policyDigest: compiled.result.identity.policyDigest,
        engineDigest: compiled.result.identity.engineDigest,
        rego: compiled.result.source.rego,
        data: compiled.result.source.data,
        ranges: sourceRanges(compiled.result.bundle),
        evaluation,
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw engineFailure();
      return result;
    });
  }
  async diff(actor: string, scope: PolicyAuthoringScope, id: string, from: number, to: number): Promise<PolicyRevisionDiffV1> {
    return this.safe(async () => {
      const row = await this.scoped(this.deps.db, scope, id);
      await this.allowed("view", actor, scope, this.deps.db);
      const a = await this.revision(this.deps.db, row, from),
        b = await this.revision(this.deps.db, row, to),
        am = new Map(a.draft.rules.map((r) => [r.ruleId, digest(r)])),
        bm = new Map(b.draft.rules.map((r) => [r.ruleId, digest(r)]));
      return {
        schemaVersion: 1,
        fromRevision: from,
        toRevision: to,
        addedRuleIds: [...bm.keys()].filter((x) => !am.has(x)).sort(),
        removedRuleIds: [...am.keys()].filter((x) => !bm.has(x)).sort(),
        changedRuleIds: [...am.keys()].filter((x) => bm.has(x) && am.get(x) !== bm.get(x)).sort(),
        regoChanged: bundlePart(a, "policies/") !== bundlePart(b, "policies/"),
        dataChanged: bundlePart(a, "data/") !== bundlePart(b, "data/"),
        provenanceChanged: bundlePart(a, "provenance/") !== bundlePart(b, "provenance/"),
        fromIdentity: a.normalizedIdentity,
        toIdentity: b.normalizedIdentity,
        ...(a.sourceBundleDigest ? { fromSourceBundleDigest: a.sourceBundleDigest } : {}),
        ...(b.sourceBundleDigest ? { toSourceBundleDigest: b.sourceBundleDigest } : {}),
      };
    });
  }
  private async transition(actor: string, scope: PolicyAuthoringScope, id: string, input: PolicyMutationBase) {
    return this.safe(async () => {
      base(input);
      await this.preflight("submit_review", actor, scope, id);
      const op = operationIdentity(scope, actor, "submit_review", id, input),
        replay = await findReplay(this.deps.db, op);
      if (replay) return replay;
      return this.deps.db.transaction(async (tx) => {
        const old = await this.scoped(tx, scope, id);
        await this.allowed("submit_review", actor, scope, tx);
        const again = await claim(tx, op, this.now());
        if (again) return again;
        cas(old, input);
        if (old.status !== "draft") throw conflict();
        if (!old.validationSummary.publishable || !old.engineDigest) throw unsupported();
        const cycle = old.stateVersion + 1,
          updated = await tx
            .update(policyAuthoringDocuments)
            .set({ status: "in_review", stateVersion: cycle, reviewCycle: cycle, updatedAt: this.now() })
            .where(casWhere(old, input))
            .returning();
        if (!updated[0]) throw conflict();
        return this.finish(tx, toDocument(updated[0]), actor, "submit_review", input.idempotencyKey, old.status, op);
      });
    });
  }
  private async normalized(draft: unknown, scope: PolicyAuthoringScope) {
    const issues = validatePolicyDraft(draft);
    if (issues.length) throw new PolicyAuthoringError("invalid", issues[0].message, 422);
    const normalized = normalizePolicyDraft(draft as Parameters<typeof normalizePolicyDraft>[0]);
    try {
      const result = await this.compiler.compile(normalized, scope);
      validateCompilation(result);
      return { draft: normalized, result };
    } catch (error) {
      if (error instanceof PolicyAuthoringError) throw error;
      throw engineFailure();
    }
  }
  private assertScope(draft: unknown, scope: PolicyAuthoringScope) {
    if (!draft || typeof draft !== "object" || "normalizedIdentity" in draft || !("rules" in draft) || !Array.isArray(draft.rules))
      invalid("Remove client-computed identity and digest fields before you retry.");
    for (const rule of draft.rules) {
      if (!rule || typeof rule !== "object" || !("owner" in rule) || !rule.owner || typeof rule.owner !== "object") continue;
      const owner = rule.owner as { kind?: unknown; id?: unknown };
      if (scope.teamId ? owner.kind !== "team" || owner.id !== scope.teamId : owner.kind !== "org" || owner.id !== scope.organizationId)
        invalid("Set every rule owner to the policy draft scope before you retry.");
    }
  }
  private async preflight(op: PolicyAuthoringOperation, actor: string, scope: PolicyAuthoringScope, id: string) {
    const row = await this.scoped(this.deps.db, scope, id);
    await this.allowed(op, actor, scope, this.deps.db);
    return row;
  }
  private async allowed(op: PolicyAuthoringOperation, actor: string, scope: PolicyAuthoringScope, db: AppQueryable) {
    if (!actor || !scope.organizationId) throw new PolicyAuthoringError("forbidden", "Sign in with policy authoring access.", 403);
    try {
      const d = await this.deps.authorizer.authorize(op, actor, scope, db);
      if (d === "not_found") throw new PolicyAuthoringError("not_found", "Policy draft not found.", 404);
      if (!d) throw new PolicyAuthoringError("forbidden", "Ask a policy administrator for access to this scope.", 403);
    } catch (e) {
      if (e instanceof PolicyAuthoringError) throw e;
      throw new PolicyAuthoringError("forbidden", "Retry after policy authoring authorization is available.", 403);
    }
  }
  private async scoped(db: AppQueryable, scope: PolicyAuthoringScope, id: string) {
    const row = (
      await db
        .select()
        .from(policyAuthoringDocuments)
        .where(and(eq(policyAuthoringDocuments.id, id), eq(policyAuthoringDocuments.orgId, scope.organizationId), eq(policyAuthoringDocuments.scopeKey, scopeKey(scope))))
        .limit(1)
    )[0];
    if (!row) throw new PolicyAuthoringError("not_found", "Policy draft not found.", 404);
    return row;
  }
  private async revision(db: AppQueryable, row: Pick<DocumentRow, "orgId" | "scopeKey" | "id">, revision: number) {
    const found = (
      await db
        .select()
        .from(policyAuthoringRevisions)
        .where(
          and(
            eq(policyAuthoringRevisions.orgId, row.orgId),
            eq(policyAuthoringRevisions.scopeKey, row.scopeKey),
            eq(policyAuthoringRevisions.documentId, row.id),
            eq(policyAuthoringRevisions.revision, revision),
          ),
        )
        .limit(1)
    )[0];
    if (!found) throw new PolicyAuthoringError("not_found", "Select a revision that belongs to this policy draft.", 404);
    return found;
  }
  private async finish(tx: AppQueryable, result: PolicyAuthoringDocument, actor: string, operation: MutationOperation, key: string, prior: string | null, op: OperationIdentity) {
    await this.auditWrite(tx, result, actor, operation, key, prior, this.now());
    await tx.update(policyAuthoringOperations).set({ response: result }).where(operationWhere(op));
    return result;
  }
  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof PolicyAuthoringError ||
        error instanceof CanonicalPolicyConfigManagedError ||
        error instanceof CanonicalPolicySourceReadOnlyError
      ) throw error;
      throw internal();
    }
  }
}
interface OperationIdentity {
  org: string;
  scope: string;
  actor: string;
  operation: MutationOperation;
  document: string;
  key: string;
  payload: string;
}
function operationIdentity(scope: PolicyAuthoringScope, actor: string, operation: MutationOperation, document: string, input: unknown): OperationIdentity {
  const key = (input as { idempotencyKey?: string }).idempotencyKey ?? (input as { input?: { idempotencyKey?: string } }).input?.idempotencyKey ?? "",
    fixed = { org: scope.organizationId, scope: scopeKey(scope), actor, operation, document, key };
  return { ...fixed, payload: digest({ ...fixed, input }) };
}
function operationWhere(x: OperationIdentity) {
  return and(
    eq(policyAuthoringOperations.orgId, x.org),
    eq(policyAuthoringOperations.scopeKey, x.scope),
    eq(policyAuthoringOperations.actorId, x.actor),
    eq(policyAuthoringOperations.operation, x.operation),
    eq(policyAuthoringOperations.documentKey, x.document),
    eq(policyAuthoringOperations.idempotencyKey, x.key),
  );
}
async function findReplay(db: AppQueryable, op: OperationIdentity) {
  const row = (await db.select().from(policyAuthoringOperations).where(operationWhere(op)).limit(1))[0];
  if (!row) return;
  if (row.payloadDigest !== op.payload) throw conflict("This idempotency key has different input. Use a new key for the changed request.");
  if (!row.response) throw conflict("The first request is still running. Retry this request later.");
  return row.response;
}
async function claim(db: AppQueryable, op: OperationIdentity, now: number) {
  const inserted = await db
    .insert(policyAuthoringOperations)
    .values({
      orgId: op.org,
      scopeKey: op.scope,
      actorId: op.actor,
      operation: op.operation,
      documentKey: op.document,
      documentId: op.operation === "create" ? null : op.document,
      idempotencyKey: op.key,
      payloadDigest: op.payload,
      response: null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ key: policyAuthoringOperations.idempotencyKey });
  return inserted[0] ? undefined : findReplay(db, op);
}
function scopeKey(scope: PolicyAuthoringScope) {
  return scope.teamId ? `team:${scope.teamId}` : "org";
}
function documentValues(
  id: string,
  scope: PolicyAuthoringScope,
  actor: string,
  compiled: { draft: NormalizedPolicyDraftV1; result: Awaited<ReturnType<PolicyAuthoringCompiler["compile"]>> },
  now: number,
) {
  return {
    id,
    orgId: scope.organizationId,
    scopeKey: scopeKey(scope),
    teamId: scope.teamId ?? null,
    status: "draft" as const,
    revision: 1,
    stateVersion: 1,
    reviewCycle: null,
    normalizedIdentity: compiled.draft.normalizedIdentity,
    sourceBundleDigest: compiled.result.identity?.sourceBundleDigest ?? null,
    policyDigest: compiled.result.identity?.policyDigest ?? null,
    engineDigest: compiled.result.identity?.engineDigest ?? null,
    validationSummary: compiled.result.validation,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
}
function toDocument(row: DocumentRow): PolicyAuthoringDocument {
  return {
    schemaVersion: 1,
    documentId: row.id,
    scope: { organizationId: row.orgId, ...(row.teamId ? { teamId: row.teamId } : {}) },
    status: row.status,
    revision: row.revision,
    stateVersion: row.stateVersion,
    ...(row.reviewCycle ? { reviewCycle: row.reviewCycle } : {}),
    normalizedIdentity: row.normalizedIdentity,
    ...(row.sourceBundleDigest ? { sourceBundleDigest: row.sourceBundleDigest } : {}),
    ...(row.policyDigest ? { policyDigest: row.policyDigest } : {}),
    ...(row.engineDigest ? { engineDigest: row.engineDigest } : {}),
    validation: row.validationSummary,
    createdBy: row.createdBy,
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
  };
}
async function insertRevision(db: AppQueryable, row: DocumentRow, draft: NormalizedPolicyDraftV1, bundle: CanonicalSourceBundle | undefined, actor: string, now: number) {
  await db.insert(policyAuthoringRevisions).values({
    orgId: row.orgId,
    scopeKey: row.scopeKey,
    documentId: row.id,
    revision: row.revision,
    draft,
    normalizedIdentity: draft.normalizedIdentity,
    bundle: bundle ?? null,
    sourceBundleDigest: row.sourceBundleDigest,
    policyDigest: row.policyDigest,
    engineDigest: row.engineDigest,
    validationSummary: row.validationSummary,
    createdBy: actor,
    createdAt: now,
  });
}
async function writeAudit(db: AppQueryable, result: PolicyAuthoringDocument, actor: string, operation: string, key: string, prior: string | null, now: number) {
  await db.insert(policyAuthoringAudit).values({
    id: randomUUID(),
    orgId: result.scope.organizationId,
    scopeKey: scopeKey(result.scope),
    teamId: result.scope.teamId ?? null,
    documentId: result.documentId,
    revision: result.revision,
    stateVersion: result.stateVersion,
    reviewCycle: result.reviewCycle ?? null,
    actorId: actor,
    operation,
    idempotencyKey: key,
    priorState: prior,
    newState: result.status,
    sourceBundleDigest: result.sourceBundleDigest ?? null,
    policyDigest: result.policyDigest ?? null,
    engineDigest: result.engineDigest ?? null,
    createdAt: now,
  });
}
function base(input: PolicyMutationBase, create = false, extra: readonly string[] = []) {
  const allowed = ["schemaVersion", "expectedRevision", "expectedStateVersion", "idempotencyKey", ...(create ? ["draft"] : []), ...extra];
  if (
    !input ||
    input.schemaVersion !== 1 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    !Number.isSafeInteger(input.expectedStateVersion) ||
    !/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    invalid("Send the expected versions and a stable idempotency key before you retry.");
  if (create && (input.expectedRevision !== 0 || input.expectedStateVersion !== 0)) throw conflict();
}
function cas(row: DocumentRow, input: Pick<PolicyMutationBase, "expectedRevision" | "expectedStateVersion">) {
  if (row.revision !== input.expectedRevision || row.stateVersion !== input.expectedStateVersion) throw conflict();
}
function casWhere(row: DocumentRow, input: PolicyMutationBase) {
  return and(
    eq(policyAuthoringDocuments.orgId, row.orgId),
    eq(policyAuthoringDocuments.scopeKey, row.scopeKey),
    eq(policyAuthoringDocuments.id, row.id),
    eq(policyAuthoringDocuments.revision, input.expectedRevision),
    eq(policyAuthoringDocuments.stateVersion, input.expectedStateVersion),
  );
}
function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v)))
    .digest("hex");
}
function bundlePart(row: RevisionRow, prefix: string) {
  return digest(row.bundle?.files.filter((f) => f.path.startsWith(prefix)) ?? []);
}
function issue(code: string, path: string, message: string): DraftValidationIssue {
  return { code, path, message };
}
function invalid(message: string): never {
  throw new PolicyAuthoringError("invalid", message, 400);
}
function conflict(message = "The policy draft changed. Refresh it and retry with its current revision and state version.") {
  return new PolicyAuthoringError("conflict", message, 409);
}
function unsupported(): never {
  throw new PolicyAuthoringError("unsupported", "Change this policy to a supported context before review or preparation.", 422);
}
function internal() {
  return new PolicyAuthoringError("internal", "Policy authoring failed. Retry the request. If it fails again, contact support.", 500);
}
function engineFailure() {
  return new PolicyAuthoringError("unsupported", "Policy validation failed closed. Correct the policy or retry after the policy engine is available.", 422);
}
function completeIdentity(row: RevisionRow): row is RevisionRow & { sourceBundleDigest: string; policyDigest: string; engineDigest: string } {
  return Boolean(row.sourceBundleDigest && row.policyDigest && row.engineDigest);
}
function sameStoredIdentity(a: ValidatedBundleIdentity, b: { sourceBundleDigest: string | null; policyDigest: string | null; engineDigest: string | null }) {
  return a.sourceBundleDigest === b.sourceBundleDigest && a.policyDigest === b.policyDigest && a.engineDigest === b.engineDigest;
}
function sameIdentity(a: ValidatedBundleIdentity, b: ValidatedBundleIdentity) {
  return sameStoredIdentity(a, b);
}
function validateCompilation(result: Awaited<ReturnType<PolicyAuthoringCompiler["compile"]>>) {
  if (!result.validation || typeof result.validation.valid !== "boolean" || typeof result.validation.publishable !== "boolean" || !Array.isArray(result.validation.issues))
    throw new Error("invalid compiler result");
  const complete = Boolean(result.bundle && result.identity && result.source);
  if (result.validation.publishable !== complete) throw new Error("incomplete compiler result");
  if (result.identity && ![result.identity.sourceBundleDigest, result.identity.policyDigest, result.identity.engineDigest].every((x) => /^[0-9a-f]{64}$/.test(x)))
    throw new Error("invalid identity");
  if (result.source && (Buffer.byteLength(result.source.rego) > 256 * 1024 || Buffer.byteLength(result.source.data) > 256 * 1024)) throw new Error("oversized source");
}
function validateEvaluation(result: object, identity: ValidatedBundleIdentity) {
  const value = result as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    value.sourceBundleDigest !== identity.sourceBundleDigest ||
    value.policyDigest !== identity.policyDigest ||
    (value.evaluator as Record<string, unknown>).engineDigest !== identity.engineDigest ||
    !value.evaluator ||
    !value.decision
  )
    throw new Error("invalid evaluation");
}
function previewRequest(draft: NormalizedPolicyDraftV1, scope: PolicyAuthoringScope, actor: string, facts: Readonly<Record<string, JsonValue>>, now: number): AuthorizationRequest {
  const target = draft.rules[0]?.target ?? {},
    action = typeof target["action.id"] === "string" ? target["action.id"] : undefined,
    service = typeof target["action.service"] === "string" ? target["action.service"] : (action?.split(".")[0] ?? "preview");
  return {
    schemaVersion: 1,
    requestId: randomUUID(),
    idempotencyKey: `policy-preview:${randomUUID()}`,
    kind: "tool.action",
    subject: {
      orgId: scope.organizationId,
      principal: { type: scope.teamId ? "team" : "org", id: scope.teamId ?? scope.organizationId },
      invocation: { type: "route", id: "policy-authoring-preview" },
      actorUserId: actor,
    },
    action: {
      id: action ?? `${service}.preview`,
      service,
      riskLevel: typeof target["action.riskLevel"] === "string" ? target["action.riskLevel"] : "low",
      parameters: Object.fromEntries(
        Object.entries(facts)
          .filter(([k]) => k.startsWith("parameters."))
          .map(([k, v]) => [k.slice(11), v]),
      ),
    },
    context: { evaluationTimeMs: now },
    facts: {},
  };
}
function sourceRanges(bundle: CanonicalSourceBundle) {
  const file = bundle.files.find((x) => x.path.startsWith("provenance/"));
  if (!file) throw engineFailure();
  let parsed: { entries?: { rule_id?: unknown; start_line?: unknown; end_line?: unknown }[] };
  try {
    parsed = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8"));
  } catch {
    throw engineFailure();
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length > 256) throw engineFailure();
  return parsed.entries.map((x) => {
    if (
      typeof x.rule_id !== "string" ||
      !Number.isSafeInteger(x.start_line) ||
      !Number.isSafeInteger(x.end_line) ||
      Number(x.start_line) < 1 ||
      Number(x.end_line) < Number(x.start_line)
    )
      throw engineFailure();
    return { ruleId: x.rule_id, startLine: Number(x.start_line), endLine: Number(x.end_line) };
  });
}
