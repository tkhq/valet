import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { AuthorizationRequest, JsonValue } from "@valet/engine/authorization";
import type { AppDb, AppQueryable } from "../../lib/drizzle.js";
import { policyAuthoringAudit, policyAuthoringDocuments, policyAuthoringOperations, policyAuthoringReviews, policyAuthoringRevisions } from "../../schema/index.js";
import { buildCurrentPolicySource } from "../bundles/current-policy-source.js";
import { SourceBundleHost } from "../bundles/host.js";
import { InMemorySourceBundleStorage } from "../bundles/in-memory-storage.js";
import { LocalValetEvaluator } from "../evaluators/local-valet.js";
import type { CanonicalSourceBundle, ValidatedBundleIdentity } from "../bundles/types.js";
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
    readonly code: "invalid" | "conflict" | "forbidden" | "not_found" | "unsupported" | "self_review",
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 | 422,
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
  ): Promise<{
    bundle?: CanonicalSourceBundle;
    identity?: ValidatedBundleIdentity;
    validation: PolicyValidationSummary;
    source?: { rego: string; data: string };
  }>;
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
      const identity = await runtime.run<ValidatedBundleIdentity>({
        operation: "validate_bundle",
        bundle: built.bundle,
      });
      return {
        bundle: built.bundle,
        identity,
        validation: { valid: true, publishable: true, issues: [] },
        source: { rego: built.policySource, data: built.canonicalData },
      };
    } catch (error) {
      return {
        validation: {
          valid: false,
          publishable: false,
          issues: [issue("source_validation", "rules", error instanceof Error ? error.message : "The policy engine rejected this draft.")],
        },
      };
    }
  },
  async evaluate(bundle, identity, request) {
    runtime ??= new WasmPolicyRuntime();
    const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime);
    const validated = await host.publish(bundle);
    if (!sameIdentity(validated, identity)) throw new Error("Candidate identity changed during preview validation.");
    await host.activate(request.subject.orgId, undefined, identity.sourceBundleDigest);
    const evaluator = await LocalValetEvaluator.create(host, runtime);
    return evaluator.evaluate(request);
  },
};

interface ServiceDeps {
  db: AppDb;
  authorizer: PolicyAuthoringAuthorizer;
  compiler?: PolicyAuthoringCompiler;
  now?: () => number;
  auditWrite?: typeof writeAudit;
}
type DocumentRow = typeof policyAuthoringDocuments.$inferSelect;
type RevisionRow = typeof policyAuthoringRevisions.$inferSelect;
export class PolicyAuthoringService {
  private readonly compiler: PolicyAuthoringCompiler;
  private readonly now: () => number;
  private readonly auditWrite: typeof writeAudit;
  constructor(private readonly deps: ServiceDeps) {
    this.compiler = deps.compiler ?? policyAuthoringCompiler;
    this.now = deps.now ?? Date.now;
    this.auditWrite = deps.auditWrite ?? writeAudit;
  }

  async list(actorId: string, scope: PolicyAuthoringScope): Promise<PolicyAuthoringDocument[]> {
    await this.allowed("view", actorId, scope, this.deps.db);
    return (await this.deps.db.select().from(policyAuthoringDocuments).where(scopeWhere(scope)).orderBy(asc(policyAuthoringDocuments.updatedAt))).map(toDocument);
  }
  async get(
    actorId: string,
    scope: PolicyAuthoringScope,
    documentId: string,
  ): Promise<{
    document: PolicyAuthoringDocument;
    draft: NormalizedPolicyDraftV1;
  }> {
    await this.allowed("view", actorId, scope, this.deps.db);
    const row = await this.row(this.deps.db, scope, documentId),
      revision = await this.revision(this.deps.db, row.id, row.revision);
    return { document: toDocument(row), draft: revision.draft };
  }
  async create(actorId: string, scope: PolicyAuthoringScope, input: CreatePolicyDraftRequest): Promise<PolicyAuthoringDocument> {
    base(input, true);
    this.assertScope(input.draft, scope);
    const compiled = await this.normalized(input.draft, scope),
      documentId = input.draft.draftId,
      payload = digest({ scope, input });
    return this.deps.db.transaction(async (tx) => {
      await this.allowed("edit", actorId, scope, tx);
      const replay = await idempotent(tx, scope.organizationId, input.idempotencyKey, "create", payload);
      if (replay) return replay;
      if (
        await tx
          .select({ id: policyAuthoringDocuments.id })
          .from(policyAuthoringDocuments)
          .where(eq(policyAuthoringDocuments.id, documentId))
          .limit(1)
          .then((rows) => rows[0])
      )
        throw conflict();
      const now = this.now(),
        values = {
          id: documentId,
          orgId: scope.organizationId,
          teamId: scope.teamId ?? null,
          status: "draft" as const,
          revision: 1,
          stateVersion: 1,
          normalizedIdentity: compiled.draft.normalizedIdentity,
          sourceBundleDigest: compiled.result.identity?.sourceBundleDigest ?? null,
          policyDigest: compiled.result.identity?.policyDigest ?? null,
          validationSummary: compiled.result.validation,
          createdBy: actorId,
          createdAt: now,
          updatedAt: now,
        };
      await tx.insert(policyAuthoringDocuments).values(values);
      await insertRevision(tx, values, compiled.draft, compiled.result.bundle, actorId, now);
      const result = toDocument(values);
      await this.finish(tx, result, actorId, "create", input.idempotencyKey, null, payload);
      return result;
    });
  }
  async edit(actorId: string, scope: PolicyAuthoringScope, documentId: string, input: EditPolicyDraftRequest): Promise<PolicyAuthoringDocument> {
    base(input, false, ["draft"]);
    this.assertScope(input.draft, scope);
    const compiled = await this.normalized(input.draft, scope),
      payload = digest({ documentId, input });
    return this.deps.db.transaction(async (tx) => {
      await this.allowed("edit", actorId, scope, tx);
      const replay = await idempotent(tx, scope.organizationId, input.idempotencyKey, "edit", payload);
      if (replay) return replay;
      const old = await this.row(tx, scope, documentId);
      cas(old, input);
      const now = this.now(),
        revision = old.revision + 1,
        stateVersion = old.stateVersion + 1;
      const updated = await tx
        .update(policyAuthoringDocuments)
        .set({
          status: "draft",
          revision,
          stateVersion,
          normalizedIdentity: compiled.draft.normalizedIdentity,
          sourceBundleDigest: compiled.result.identity?.sourceBundleDigest ?? null,
          policyDigest: compiled.result.identity?.policyDigest ?? null,
          validationSummary: compiled.result.validation,
          updatedAt: now,
        })
        .where(
          and(
            eq(policyAuthoringDocuments.id, documentId),
            eq(policyAuthoringDocuments.revision, input.expectedRevision),
            eq(policyAuthoringDocuments.stateVersion, input.expectedStateVersion),
          ),
        )
        .returning();
      if (!updated[0]) throw conflict();
      await insertRevision(tx, updated[0], compiled.draft, compiled.result.bundle, actorId, now);
      const result = toDocument(updated[0]);
      await this.finish(tx, result, actorId, "edit", input.idempotencyKey, old.status, payload);
      return result;
    });
  }
  async submit(actorId: string, scope: PolicyAuthoringScope, documentId: string, input: PolicyMutationBase): Promise<PolicyAuthoringDocument> {
    return this.transition(actorId, scope, documentId, input, "submit_review", "in_review", ["draft"], true);
  }
  async review(actorId: string, scope: PolicyAuthoringScope, documentId: string, input: ReviewPolicyDraftRequest): Promise<PolicyAuthoringDocument> {
    base(input, false, ["verdict", "requestId"]);
    if (
      !input.requestId ||
      !["approve", "reject"].includes(input.verdict) ||
      Object.keys(input).some((key) => !["schemaVersion", "expectedRevision", "expectedStateVersion", "idempotencyKey", "verdict", "requestId"].includes(key))
    )
      invalid("Send one review verdict and request ID.");
    const payload = digest({ documentId, input });
    return this.deps.db.transaction(async (tx) => {
      await this.allowed("review", actorId, scope, tx);
      const replay = await idempotent(tx, scope.organizationId, input.idempotencyKey, "review", payload);
      if (replay) return replay;
      const old = await this.row(tx, scope, documentId);
      cas(old, input);
      if (old.status !== "in_review") throw conflict("Only the exact in-review revision can be reviewed.");
      const revision = await this.revision(tx, old.id, old.revision);
      if (revision.createdBy === actorId) throw new PolicyAuthoringError("self_review", "A different administrator must review this revision.", 403);
      if (!revision.sourceBundleDigest || !revision.policyDigest) throw unsupported();
      const status = input.verdict === "approve" ? ("approved_for_publication" as const) : ("draft" as const),
        stateVersion = old.stateVersion + 1,
        now = this.now();
      const updated = await tx
        .update(policyAuthoringDocuments)
        .set({ status, stateVersion, updatedAt: now })
        .where(
          and(
            eq(policyAuthoringDocuments.id, old.id),
            eq(policyAuthoringDocuments.stateVersion, input.expectedStateVersion),
            eq(policyAuthoringDocuments.revision, input.expectedRevision),
          ),
        )
        .returning();
      if (!updated[0]) throw conflict();
      await tx.insert(policyAuthoringReviews).values({
        id: randomUUID(),
        documentId,
        revision: old.revision,
        normalizedIdentity: old.normalizedIdentity,
        sourceBundleDigest: revision.sourceBundleDigest,
        policyDigest: revision.policyDigest,
        reviewerId: actorId,
        verdict: input.verdict,
        requestId: input.requestId,
        createdAt: now,
      });
      const result = toDocument(updated[0]);
      await this.finish(tx, result, actorId, "review", input.idempotencyKey, old.status, payload);
      return result;
    });
  }
  async restore(actorId: string, scope: PolicyAuthoringScope, documentId: string, fromRevision: number, input: PolicyMutationBase): Promise<PolicyAuthoringDocument> {
    base(input);
    const payload = digest({ documentId, fromRevision, input });
    return this.deps.db.transaction(async (tx) => {
      await this.allowed("restore_draft", actorId, scope, tx);
      const replay = await idempotent(tx, scope.organizationId, input.idempotencyKey, "restore_draft", payload);
      if (replay) return replay;
      const old = await this.row(tx, scope, documentId);
      cas(old, input);
      const source = await this.revision(tx, documentId, fromRevision),
        now = this.now(),
        revision = old.revision + 1,
        stateVersion = old.stateVersion + 1;
      const updated = await tx
        .update(policyAuthoringDocuments)
        .set({
          status: "draft",
          revision,
          stateVersion,
          normalizedIdentity: source.normalizedIdentity,
          sourceBundleDigest: source.sourceBundleDigest,
          policyDigest: source.policyDigest,
          validationSummary: source.validationSummary,
          updatedAt: now,
        })
        .where(
          and(
            eq(policyAuthoringDocuments.id, old.id),
            eq(policyAuthoringDocuments.stateVersion, input.expectedStateVersion),
            eq(policyAuthoringDocuments.revision, input.expectedRevision),
          ),
        )
        .returning();
      if (!updated[0]) throw conflict();
      await insertRevision(tx, updated[0], source.draft, source.bundle ?? undefined, actorId, now);
      const result = toDocument(updated[0]);
      await this.finish(tx, result, actorId, "restore_draft", input.idempotencyKey, old.status, payload);
      return result;
    });
  }
  async prepare(actorId: string, scope: PolicyAuthoringScope, documentId: string, expected: Pick<PolicyMutationBase, "expectedRevision" | "expectedStateVersion">) {
    await this.allowed("prepare_publication", actorId, scope, this.deps.db);
    const row = await this.row(this.deps.db, scope, documentId);
    cas(row, { ...expected, schemaVersion: 1, idempotencyKey: "read" });
    if (row.status !== "approved_for_publication") throw conflict("Approve this exact revision before preparation.");
    const revision = await this.revision(this.deps.db, row.id, row.revision),
      rebuilt = (await this.normalized(revision.draft, scope)).result;
    if (
      !rebuilt.validation.publishable ||
      !rebuilt.bundle ||
      !rebuilt.identity ||
      rebuilt.identity.sourceBundleDigest !== row.sourceBundleDigest ||
      rebuilt.identity.policyDigest !== row.policyDigest
    )
      throw conflict("The approved candidate did not revalidate to the same digests.");
    return {
      document: toDocument(row),
      draft: revision.draft,
      bundle: rebuilt.bundle,
      notice: "This candidate has no enforcement effect. PR 9 owns publication and activation.",
    };
  }
  async preview(actorId: string, scope: PolicyAuthoringScope, input: PolicyPreviewServerRequest) {
    await this.allowed("view", actorId, scope, this.deps.db);
    if (input.schemaVersion !== 1 || Object.keys(input).some((key) => !["schemaVersion", "draft", "sampleFacts", "clientNormalizedIdentity"].includes(key)))
      invalid("Send a version 1 preview request without unknown fields.");
    this.assertScope(input.draft, scope);
    const compiled = await this.normalized(input.draft, scope);
    if (input.clientNormalizedIdentity && input.clientNormalizedIdentity !== compiled.draft.normalizedIdentity) invalid("Normalize the current draft again before preview.");
    if (!compiled.result.bundle || !compiled.result.identity || !compiled.result.source) throw unsupported();
    const context = compiled.draft.rules[0]?.context ?? "tool.action";
    const facts = sanitizeSampleFacts(context, input.sampleFacts);
    const request = previewRequest(compiled.draft, scope, actorId, facts);
    let evaluated: object;
    try {
      evaluated = await this.compiler.evaluate(compiled.result.bundle, compiled.result.identity, request);
      validateEvaluation(evaluated, compiled.result.identity);
    } catch (error) {
      throw engineFailure(error);
    }
    try {
      const result = {
        schemaVersion: 1,
        identity: compiled.draft.normalizedIdentity,
        sourceBundleDigest: compiled.result.identity.sourceBundleDigest,
        policyDigest: compiled.result.identity.policyDigest,
        rego: compiled.result.source.rego,
        data: compiled.result.source.data,
        ranges: sourceRanges(compiled.result.bundle),
        evaluation: evaluated,
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new Error("Preview output exceeded 512 KiB.");
      return result;
    } catch (error) {
      throw engineFailure(error);
    }
  }
  async diff(actorId: string, scope: PolicyAuthoringScope, documentId: string, from: number, to: number): Promise<PolicyRevisionDiffV1> {
    await this.allowed("view", actorId, scope, this.deps.db);
    await this.row(this.deps.db, scope, documentId);
    const a = await this.revision(this.deps.db, documentId, from),
      b = await this.revision(this.deps.db, documentId, to),
      am = new Map(a.draft.rules.map((r) => [r.ruleId, digest(r)])),
      bm = new Map(b.draft.rules.map((r) => [r.ruleId, digest(r)]));
    return {
      schemaVersion: 1,
      fromRevision: from,
      toRevision: to,
      addedRuleIds: [...bm.keys()].filter((id) => !am.has(id)).sort(),
      removedRuleIds: [...am.keys()].filter((id) => !bm.has(id)).sort(),
      changedRuleIds: [...am.keys()].filter((id) => bm.has(id) && am.get(id) !== bm.get(id)).sort(),
      regoChanged: bundlePart(a, "policies/") !== bundlePart(b, "policies/"),
      dataChanged: bundlePart(a, "data/") !== bundlePart(b, "data/"),
      provenanceChanged: bundlePart(a, "provenance/") !== bundlePart(b, "provenance/"),
      fromIdentity: a.normalizedIdentity,
      toIdentity: b.normalizedIdentity,
      ...(a.sourceBundleDigest ? { fromSourceBundleDigest: a.sourceBundleDigest } : {}),
      ...(b.sourceBundleDigest ? { toSourceBundleDigest: b.sourceBundleDigest } : {}),
    };
  }
  private async transition(
    actorId: string,
    scope: PolicyAuthoringScope,
    documentId: string,
    input: PolicyMutationBase,
    operation: PolicyAuthoringOperation,
    next: "in_review",
    legal: readonly string[],
    publishable: boolean,
  ) {
    base(input);
    const payload = digest({ documentId, input });
    return this.deps.db.transaction(async (tx) => {
      await this.allowed(operation, actorId, scope, tx);
      const replay = await idempotent(tx, scope.organizationId, input.idempotencyKey, operation, payload);
      if (replay) return replay;
      const old = await this.row(tx, scope, documentId);
      cas(old, input);
      if (!legal.includes(old.status)) throw conflict();
      if (publishable && !old.validationSummary.publishable) throw unsupported();
      const updated = await tx
        .update(policyAuthoringDocuments)
        .set({
          status: next,
          stateVersion: old.stateVersion + 1,
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(policyAuthoringDocuments.id, old.id),
            eq(policyAuthoringDocuments.revision, input.expectedRevision),
            eq(policyAuthoringDocuments.stateVersion, input.expectedStateVersion),
          ),
        )
        .returning();
      if (!updated[0]) throw conflict();
      const result = toDocument(updated[0]);
      await this.finish(tx, result, actorId, operation, input.idempotencyKey, old.status, payload);
      return result;
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
      throw engineFailure(error);
    }
  }
  private assertScope(draft: unknown, scope: PolicyAuthoringScope) {
    if (!draft || typeof draft !== "object" || "normalizedIdentity" in draft || !("rules" in draft) || !Array.isArray(draft.rules))
      invalid("Do not send client-computed identity or digest fields.");
    for (const rule of draft.rules) {
      if (!rule || typeof rule !== "object" || !("owner" in rule) || !rule.owner || typeof rule.owner !== "object") continue;
      const owner = rule.owner as { kind?: unknown; id?: unknown };
      if (scope.teamId ? owner.kind !== "team" || owner.id !== scope.teamId : owner.kind !== "org" || owner.id !== scope.organizationId)
        invalid("Every rule must match the document organization or team scope.");
    }
  }
  private async allowed(op: PolicyAuthoringOperation, actor: string, scope: PolicyAuthoringScope, db: AppQueryable) {
    if (!actor || !scope.organizationId) throw new PolicyAuthoringError("forbidden", "Sign in with policy authoring access.", 403);
    try {
      const decision = await this.deps.authorizer.authorize(op, actor, scope, db);
      if (decision === "not_found") throw new PolicyAuthoringError("not_found", "Policy draft not found.", 404);
      if (!decision) throw new PolicyAuthoringError("forbidden", "You do not have policy authoring access for this scope.", 403);
    } catch (e) {
      if (e instanceof PolicyAuthoringError) throw e;
      throw new PolicyAuthoringError("forbidden", "Policy authoring authorization failed closed.", 403);
    }
  }
  private async row(db: AppQueryable, scope: PolicyAuthoringScope, id: string) {
    const row = (
      await db
        .select()
        .from(policyAuthoringDocuments)
        .where(and(eq(policyAuthoringDocuments.id, id), scopeWhere(scope)))
        .limit(1)
    )[0];
    if (!row) throw new PolicyAuthoringError("not_found", "Policy draft not found.", 404);
    return row;
  }
  private async revision(db: AppQueryable, id: string, revision: number) {
    const row = (
      await db
        .select()
        .from(policyAuthoringRevisions)
        .where(and(eq(policyAuthoringRevisions.documentId, id), eq(policyAuthoringRevisions.revision, revision)))
        .limit(1)
    )[0];
    if (!row) throw new PolicyAuthoringError("not_found", "Policy revision not found.", 404);
    return row;
  }
  private async finish(tx: AppQueryable, result: PolicyAuthoringDocument, actor: string, operation: string, key: string, prior: string | null, payload: string) {
    await this.auditWrite(tx, result, actor, operation, key, prior, this.now());
    await tx
      .update(policyAuthoringOperations)
      .set({ response: result })
      .where(
        and(
          eq(policyAuthoringOperations.orgId, result.scope.organizationId),
          eq(policyAuthoringOperations.idempotencyKey, key),
          eq(policyAuthoringOperations.payloadDigest, payload),
        ),
      );
  }
}
function scopeWhere(scope: PolicyAuthoringScope) {
  return and(eq(policyAuthoringDocuments.orgId, scope.organizationId), scope.teamId ? eq(policyAuthoringDocuments.teamId, scope.teamId) : isNull(policyAuthoringDocuments.teamId));
}
function toDocument(row: DocumentRow): PolicyAuthoringDocument {
  return {
    schemaVersion: 1,
    documentId: row.id,
    scope: {
      organizationId: row.orgId,
      ...(row.teamId ? { teamId: row.teamId } : {}),
    },
    status: row.status,
    revision: row.revision,
    stateVersion: row.stateVersion,
    normalizedIdentity: row.normalizedIdentity,
    ...(row.sourceBundleDigest ? { sourceBundleDigest: row.sourceBundleDigest } : {}),
    ...(row.policyDigest ? { policyDigest: row.policyDigest } : {}),
    validation: row.validationSummary,
    createdBy: row.createdBy,
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
  };
}
async function insertRevision(db: AppQueryable, row: DocumentRow, draft: NormalizedPolicyDraftV1, bundle: CanonicalSourceBundle | undefined, actor: string, now: number) {
  await db.insert(policyAuthoringRevisions).values({
    documentId: row.id,
    revision: row.revision,
    draft,
    normalizedIdentity: draft.normalizedIdentity,
    bundle: bundle ?? null,
    sourceBundleDigest: row.sourceBundleDigest,
    policyDigest: row.policyDigest,
    validationSummary: row.validationSummary,
    createdBy: actor,
    createdAt: now,
  });
}
async function idempotent(db: AppQueryable, org: string, key: string, op: string, payload: string) {
  const claimed = await db
    .insert(policyAuthoringOperations)
    .values({
      orgId: org,
      idempotencyKey: key,
      operation: op,
      payloadDigest: payload,
      response: null,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .returning({ key: policyAuthoringOperations.idempotencyKey });
  if (claimed[0]) return;
  const row = (
    await db
      .select()
      .from(policyAuthoringOperations)
      .where(and(eq(policyAuthoringOperations.orgId, org), eq(policyAuthoringOperations.idempotencyKey, key)))
      .limit(1)
  )[0];
  if (!row || row.operation !== op || row.payloadDigest !== payload) throw conflict("This idempotency key was already used with different input.");
  if (!row.response) throw conflict("The original idempotent operation has not committed. Retry it.");
  return row.response;
}
async function writeAudit(db: AppQueryable, result: PolicyAuthoringDocument, actor: string, operation: string, key: string, prior: string | null, now: number) {
  await db.insert(policyAuthoringAudit).values({
    id: randomUUID(),
    orgId: result.scope.organizationId,
    teamId: result.scope.teamId ?? null,
    documentId: result.documentId,
    revision: result.revision,
    stateVersion: result.stateVersion,
    actorId: actor,
    operation,
    idempotencyKey: key,
    priorState: prior,
    newState: result.status,
    sourceBundleDigest: result.sourceBundleDigest ?? null,
    policyDigest: result.policyDigest ?? null,
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
    invalid("Send expected revision, state version, and a stable idempotency key.");
  if (create && (input.expectedRevision !== 0 || input.expectedStateVersion !== 0)) throw conflict();
}
function cas(row: DocumentRow, input: PolicyMutationBase) {
  if (row.revision !== input.expectedRevision || row.stateVersion !== input.expectedStateVersion) throw conflict();
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
function invalid(message = "Send a valid scoped policy authoring request."): never {
  throw new PolicyAuthoringError("invalid", message, 400);
}
function conflict(message = "The policy draft changed. Refresh it and retry with its current revision and state version.") {
  return new PolicyAuthoringError("conflict", message, 409);
}
function unsupported(): never {
  throw new PolicyAuthoringError("unsupported", "This policy context is not ready for review or publication preparation.", 422);
}
function previewRequest(draft: NormalizedPolicyDraftV1, scope: PolicyAuthoringScope, actor: string, facts: Readonly<Record<string, JsonValue>>): AuthorizationRequest {
  const target = draft.rules[0]?.target ?? {};
  const targetAction = typeof target["action.id"] === "string" ? target["action.id"] : undefined;
  const service = typeof target["action.service"] === "string" ? target["action.service"] : (targetAction?.split(".")[0] ?? "preview");
  const parameters = Object.fromEntries(
    Object.entries(facts)
      .filter(([key]) => key.startsWith("parameters."))
      .map(([key, value]) => [key.slice(11), value]),
  );
  return {
    schemaVersion: 1,
    requestId: randomUUID(),
    idempotencyKey: `policy-preview:${randomUUID()}`,
    kind: "tool.action",
    subject: {
      orgId: scope.organizationId,
      principal: {
        type: scope.teamId ? "team" : "org",
        id: scope.teamId ?? scope.organizationId,
      },
      invocation: { type: "route", id: "policy-authoring-preview" },
      actorUserId: actor,
    },
    action: {
      id: targetAction ?? `${service}.preview`,
      service,
      riskLevel: typeof target["action.riskLevel"] === "string" ? target["action.riskLevel"] : "low",
      parameters,
    },
    context: { evaluationTimeMs: Date.now() },
    facts: {},
  };
}

function sameIdentity(a: ValidatedBundleIdentity, b: ValidatedBundleIdentity): boolean {
  return a.sourceBundleDigest === b.sourceBundleDigest && a.policyDigest === b.policyDigest && a.engineDigest === b.engineDigest;
}
function validateCompilation(result: Awaited<ReturnType<PolicyAuthoringCompiler["compile"]>>): void {
  if (!result.validation || typeof result.validation.valid !== "boolean" || typeof result.validation.publishable !== "boolean" || !Array.isArray(result.validation.issues))
    throw new Error("Compiler returned a malformed validation summary.");
  const complete = Boolean(result.bundle && result.identity && result.source);
  if (result.validation.publishable !== complete) throw new Error("Compiler returned incomplete publishable output.");
  if (result.identity && ![result.identity.sourceBundleDigest, result.identity.policyDigest, result.identity.engineDigest].every((value) => /^[0-9a-f]{64}$/.test(value)))
    throw new Error("Compiler returned a malformed bundle identity.");
  if (result.source && (Buffer.byteLength(result.source.rego) > 256 * 1024 || Buffer.byteLength(result.source.data) > 256 * 1024))
    throw new Error("Compiler source exceeded 256 KiB.");
}
function validateEvaluation(result: object, identity: ValidatedBundleIdentity): void {
  const value = result as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.sourceBundleDigest !== identity.sourceBundleDigest || value.policyDigest !== identity.policyDigest || !value.evaluator || !value.decision)
    throw new Error("Evaluator returned malformed or mismatched provenance.");
}
function sourceRanges(bundle: CanonicalSourceBundle): readonly { ruleId: string; startLine: number; endLine: number }[] {
  const file = bundle.files.find((value) => value.path.startsWith("provenance/"));
  if (!file) throw new Error("Candidate bundle has no provenance.");
  const parsed = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")) as {
    entries?: { rule_id?: unknown; start_line?: unknown; end_line?: unknown }[];
  };
  if (!Array.isArray(parsed.entries) || parsed.entries.length > 256) throw new Error("Candidate provenance is malformed.");
  return parsed.entries.map((entry) => {
    if (
      typeof entry.rule_id !== "string" ||
      !Number.isSafeInteger(entry.start_line) ||
      !Number.isSafeInteger(entry.end_line) ||
      Number(entry.start_line) < 1 ||
      Number(entry.end_line) < Number(entry.start_line)
    )
      throw new Error("Candidate provenance range is malformed.");
    return {
      ruleId: entry.rule_id,
      startLine: Number(entry.start_line),
      endLine: Number(entry.end_line),
    };
  });
}
function engineFailure(error: unknown): PolicyAuthoringError {
  const detail = error instanceof Error ? error.message : "Policy engine failure.";
  return new PolicyAuthoringError("unsupported", `Policy candidate validation failed closed: ${detail}`, 422);
}
